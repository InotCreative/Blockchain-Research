"""
Claim Submitter for SEARChain Oracle Service.

This module handles signing claims with ECDSA and submitting them
to the ProductionOracle and ConsumptionOracle contracts.

Requirements: 9.3, 9.4
"""

import os
import time
import logging
from typing import Dict, Optional, Any, Tuple
from dataclasses import dataclass
from enum import Enum

from eth_account import Account
from eth_account.messages import encode_defunct
from eth_hash.auto import keccak
from web3 import Web3
from web3.exceptions import TransactionNotFound, TimeExhausted
from web3.types import TxReceipt

# Configure logging
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)


class ClaimType(Enum):
    """Claim type for domain separation."""
    PRODUCTION = 0x01
    CONSUMPTION = 0x02


@dataclass
class ClaimData:
    """Data for a claim submission."""
    subject_id: str  # producerId or consumerId (bytes32 hex)
    hour_id: int
    energy_wh: int
    evidence_root: str  # bytes32 hex


@dataclass
class SubmissionResult:
    """Result of a claim submission."""
    success: bool
    tx_hash: Optional[str] = None
    error: Optional[str] = None
    gas_used: Optional[int] = None
    block_number: Optional[int] = None


class ClaimSigner:
    """
    Signs claims using ECDSA (secp256k1).
    
    Implements the signature format expected by ProductionOracle/ConsumptionOracle:
    messageHash = keccak256(abi.encodePacked(
        chainId,
        contractAddress,
        subjectId,  # producerId or consumerId
        hourId,
        energyWh,
        evidenceRoot
    ))
    ethSignedHash = keccak256("\\x19Ethereum Signed Message:\\n32" + messageHash)
    """
    
    def __init__(self, private_key: str):
        """
        Initialize signer with private key.
        
        Args:
            private_key: Hex-encoded private key (with or without 0x prefix)
        """
        if not private_key.startswith('0x'):
            private_key = '0x' + private_key
        
        self.account = Account.from_key(private_key)
        self.address = self.account.address
    
    def sign_claim(
        self,
        chain_id: int,
        contract_address: str,
        claim: ClaimData
    ) -> bytes:
        """
        Sign a claim for submission.
        
        Args:
            chain_id: Chain ID for domain separation
            contract_address: Oracle contract address
            claim: Claim data to sign
            
        Returns:
            Signature bytes
        """
        # Build message hash
        message_hash = self._build_message_hash(
            chain_id,
            contract_address,
            claim.subject_id,
            claim.hour_id,
            claim.energy_wh,
            claim.evidence_root
        )
        
        # Sign with Ethereum prefix
        signable = encode_defunct(primitive=message_hash)
        signed = self.account.sign_message(signable)
        
        return signed.signature
    
    def _build_message_hash(
        self,
        chain_id: int,
        contract_address: str,
        subject_id: str,
        hour_id: int,
        energy_wh: int,
        evidence_root: str
    ) -> bytes:
        """
        Build the message hash for signing.
        
        Matches Solidity:
        keccak256(abi.encodePacked(
            chainId,
            contractAddress,
            subjectId,
            hourId,
            energyWh,
            evidenceRoot
        ))
        """
        # Convert to bytes
        chain_id_bytes = chain_id.to_bytes(32, 'big')
        contract_bytes = bytes.fromhex(contract_address[2:].lower())
        subject_bytes = bytes.fromhex(subject_id[2:] if subject_id.startswith('0x') else subject_id)
        hour_id_bytes = hour_id.to_bytes(32, 'big')
        energy_wh_bytes = energy_wh.to_bytes(8, 'big')  # uint64
        evidence_bytes = bytes.fromhex(evidence_root[2:] if evidence_root.startswith('0x') else evidence_root)
        
        # Pack and hash
        packed = (
            chain_id_bytes +
            contract_bytes +
            subject_bytes +
            hour_id_bytes +
            energy_wh_bytes +
            evidence_bytes
        )
        
        return keccak(packed)


class ClaimSubmitter:
    """
    Submits signed claims to Oracle contracts.
    
    Handles:
    - Transaction building and gas estimation
    - Transaction submission with retries
    - Confirmation waiting
    """
    
    # Production Oracle ABI (minimal for submission)
    PRODUCTION_ORACLE_ABI = [
        {
            "inputs": [
                {"name": "producerId", "type": "bytes32"},
                {"name": "hourId", "type": "uint256"},
                {"name": "energyWh", "type": "uint64"},
                {"name": "evidenceRoot", "type": "bytes32"},
                {"name": "signature", "type": "bytes"}
            ],
            "name": "submitProduction",
            "outputs": [],
            "stateMutability": "nonpayable",
            "type": "function"
        },
        {
            "inputs": [
                {"name": "producerId", "type": "bytes32"},
                {"name": "hourId", "type": "uint256"}
            ],
            "name": "getClaimKey",
            "outputs": [{"name": "", "type": "bytes32"}],
            "stateMutability": "view",
            "type": "function"
        },
        {
            "inputs": [{"name": "claimKey", "type": "bytes32"}],
            "name": "isFinalized",
            "outputs": [{"name": "", "type": "bool"}],
            "stateMutability": "view",
            "type": "function"
        },
        {
            "inputs": [
                {"name": "claimKey", "type": "bytes32"},
                {"name": "verifier", "type": "address"}
            ],
            "name": "hasSubmitted",
            "outputs": [{"name": "", "type": "bool"}],
            "stateMutability": "view",
            "type": "function"
        }
    ]
    
    # Consumption Oracle ABI (minimal for submission)
    CONSUMPTION_ORACLE_ABI = [
        {
            "inputs": [
                {"name": "consumerId", "type": "bytes32"},
                {"name": "hourId", "type": "uint256"},
                {"name": "energyWh", "type": "uint64"},
                {"name": "evidenceRoot", "type": "bytes32"},
                {"name": "signature", "type": "bytes"}
            ],
            "name": "submitConsumption",
            "outputs": [],
            "stateMutability": "nonpayable",
            "type": "function"
        },
        {
            "inputs": [
                {"name": "consumerId", "type": "bytes32"},
                {"name": "hourId", "type": "uint256"}
            ],
            "name": "getClaimKey",
            "outputs": [{"name": "", "type": "bytes32"}],
            "stateMutability": "view",
            "type": "function"
        },
        {
            "inputs": [{"name": "claimKey", "type": "bytes32"}],
            "name": "isFinalized",
            "outputs": [{"name": "", "type": "bool"}],
            "stateMutability": "view",
            "type": "function"
        },
        {
            "inputs": [
                {"name": "claimKey", "type": "bytes32"},
                {"name": "verifier", "type": "address"}
            ],
            "name": "hasSubmitted",
            "outputs": [{"name": "", "type": "bool"}],
            "stateMutability": "view",
            "type": "function"
        }
    ]
    
    # Default settings
    DEFAULT_GAS_LIMIT = 500000
    DEFAULT_MAX_RETRIES = 3
    DEFAULT_RETRY_DELAY = 5  # seconds
    DEFAULT_CONFIRMATION_TIMEOUT = 120  # seconds
    
    def __init__(
        self,
        web3: Web3,
        signer: ClaimSigner,
        production_oracle_address: str,
        consumption_oracle_address: str,
        gas_limit: int = DEFAULT_GAS_LIMIT,
        max_retries: int = DEFAULT_MAX_RETRIES,
        retry_delay: int = DEFAULT_RETRY_DELAY,
        confirmation_timeout: int = DEFAULT_CONFIRMATION_TIMEOUT
    ):
        """
        Initialize claim submitter.
        
        Args:
            web3: Web3 instance
            signer: ClaimSigner for signing claims
            production_oracle_address: ProductionOracle contract address
            consumption_oracle_address: ConsumptionOracle contract address
            gas_limit: Gas limit for transactions
            max_retries: Maximum retry attempts
            retry_delay: Delay between retries in seconds
            confirmation_timeout: Timeout for transaction confirmation
        """
        self.web3 = web3
        self.signer = signer
        self.gas_limit = gas_limit
        self.max_retries = max_retries
        self.retry_delay = retry_delay
        self.confirmation_timeout = confirmation_timeout
        
        # Initialize contracts
        self.production_oracle = web3.eth.contract(
            address=Web3.to_checksum_address(production_oracle_address),
            abi=self.PRODUCTION_ORACLE_ABI
        )
        self.consumption_oracle = web3.eth.contract(
            address=Web3.to_checksum_address(consumption_oracle_address),
            abi=self.CONSUMPTION_ORACLE_ABI
        )
        
        self.chain_id = web3.eth.chain_id


    def submit_production(
        self,
        claim: ClaimData
    ) -> SubmissionResult:
        """
        Submit a production claim to ProductionOracle.
        
        Args:
            claim: Claim data to submit
            
        Returns:
            SubmissionResult with transaction details
        """
        return self._submit_claim(
            claim,
            ClaimType.PRODUCTION,
            self.production_oracle,
            "submitProduction"
        )
    
    def submit_consumption(
        self,
        claim: ClaimData
    ) -> SubmissionResult:
        """
        Submit a consumption claim to ConsumptionOracle.
        
        Args:
            claim: Claim data to submit
            
        Returns:
            SubmissionResult with transaction details
        """
        return self._submit_claim(
            claim,
            ClaimType.CONSUMPTION,
            self.consumption_oracle,
            "submitConsumption"
        )
    
    def _submit_claim(
        self,
        claim: ClaimData,
        claim_type: ClaimType,
        contract: Any,
        method_name: str
    ) -> SubmissionResult:
        """
        Internal method to submit a claim.
        
        Args:
            claim: Claim data
            claim_type: Type of claim (production/consumption)
            contract: Contract instance
            method_name: Contract method to call
            
        Returns:
            SubmissionResult
        """
        # Check if already submitted
        claim_key = contract.functions.getClaimKey(
            bytes.fromhex(claim.subject_id[2:] if claim.subject_id.startswith('0x') else claim.subject_id),
            claim.hour_id
        ).call()
        
        if contract.functions.hasSubmitted(claim_key, self.signer.address).call():
            return SubmissionResult(
                success=False,
                error="Already submitted for this claim"
            )
        
        # Check if already finalized
        if contract.functions.isFinalized(claim_key).call():
            return SubmissionResult(
                success=False,
                error="Claim already finalized"
            )
        
        # Sign the claim
        signature = self.signer.sign_claim(
            self.chain_id,
            contract.address,
            claim
        )
        
        # Build transaction
        subject_bytes = bytes.fromhex(
            claim.subject_id[2:] if claim.subject_id.startswith('0x') else claim.subject_id
        )
        evidence_bytes = bytes.fromhex(
            claim.evidence_root[2:] if claim.evidence_root.startswith('0x') else claim.evidence_root
        )
        
        # Get the contract function
        contract_func = getattr(contract.functions, method_name)
        
        # Retry loop
        for attempt in range(self.max_retries):
            try:
                # Get current nonce
                nonce = self.web3.eth.get_transaction_count(self.signer.address)
                
                # Build transaction
                tx = contract_func(
                    subject_bytes,
                    claim.hour_id,
                    claim.energy_wh,
                    evidence_bytes,
                    signature
                ).build_transaction({
                    'from': self.signer.address,
                    'gas': self.gas_limit,
                    'gasPrice': self.web3.eth.gas_price,
                    'nonce': nonce,
                    'chainId': self.chain_id
                })
                
                # Sign and send
                signed_tx = self.web3.eth.account.sign_transaction(
                    tx,
                    self.signer.account.key
                )
                tx_hash = self.web3.eth.send_raw_transaction(signed_tx.raw_transaction)
                
                logger.info(f"Submitted claim, tx: {tx_hash.hex()}")
                
                # Wait for confirmation
                receipt = self._wait_for_confirmation(tx_hash)
                
                if receipt['status'] == 1:
                    return SubmissionResult(
                        success=True,
                        tx_hash=tx_hash.hex(),
                        gas_used=receipt['gasUsed'],
                        block_number=receipt['blockNumber']
                    )
                else:
                    return SubmissionResult(
                        success=False,
                        tx_hash=tx_hash.hex(),
                        error="Transaction reverted"
                    )
                    
            except Exception as e:
                logger.warning(f"Submission attempt {attempt + 1} failed: {e}")
                if attempt < self.max_retries - 1:
                    time.sleep(self.retry_delay)
                else:
                    return SubmissionResult(
                        success=False,
                        error=str(e)
                    )
        
        return SubmissionResult(
            success=False,
            error="Max retries exceeded"
        )
    
    def _wait_for_confirmation(self, tx_hash: bytes) -> TxReceipt:
        """
        Wait for transaction confirmation.
        
        Args:
            tx_hash: Transaction hash
            
        Returns:
            Transaction receipt
            
        Raises:
            TimeExhausted: If confirmation times out
        """
        return self.web3.eth.wait_for_transaction_receipt(
            tx_hash,
            timeout=self.confirmation_timeout
        )
    
    def get_claim_key(
        self,
        subject_id: str,
        hour_id: int,
        claim_type: ClaimType
    ) -> str:
        """
        Get the claim key for a subject and hour.
        
        Args:
            subject_id: Producer or consumer ID
            hour_id: Hour identifier
            claim_type: Type of claim
            
        Returns:
            Claim key as hex string
        """
        subject_bytes = bytes.fromhex(
            subject_id[2:] if subject_id.startswith('0x') else subject_id
        )
        
        if claim_type == ClaimType.PRODUCTION:
            claim_key = self.production_oracle.functions.getClaimKey(
                subject_bytes,
                hour_id
            ).call()
        else:
            claim_key = self.consumption_oracle.functions.getClaimKey(
                subject_bytes,
                hour_id
            ).call()
        
        return '0x' + claim_key.hex()
    
    def has_submitted(
        self,
        subject_id: str,
        hour_id: int,
        claim_type: ClaimType
    ) -> bool:
        """
        Check if verifier has already submitted for a claim.
        
        Args:
            subject_id: Producer or consumer ID
            hour_id: Hour identifier
            claim_type: Type of claim
            
        Returns:
            True if already submitted
        """
        claim_key = self.get_claim_key(subject_id, hour_id, claim_type)
        claim_key_bytes = bytes.fromhex(claim_key[2:])
        
        if claim_type == ClaimType.PRODUCTION:
            return self.production_oracle.functions.hasSubmitted(
                claim_key_bytes,
                self.signer.address
            ).call()
        else:
            return self.consumption_oracle.functions.hasSubmitted(
                claim_key_bytes,
                self.signer.address
            ).call()
    
    def is_finalized(
        self,
        subject_id: str,
        hour_id: int,
        claim_type: ClaimType
    ) -> bool:
        """
        Check if a claim is finalized.
        
        Args:
            subject_id: Producer or consumer ID
            hour_id: Hour identifier
            claim_type: Type of claim
            
        Returns:
            True if finalized
        """
        claim_key = self.get_claim_key(subject_id, hour_id, claim_type)
        claim_key_bytes = bytes.fromhex(claim_key[2:])
        
        if claim_type == ClaimType.PRODUCTION:
            return self.production_oracle.functions.isFinalized(claim_key_bytes).call()
        else:
            return self.consumption_oracle.functions.isFinalized(claim_key_bytes).call()


def create_submitter_from_env(web3: Web3) -> ClaimSubmitter:
    """
    Create a ClaimSubmitter from environment variables.
    
    Required env vars:
    - VERIFIER_PRIVATE_KEY: Private key for signing
    - PRODUCTION_ORACLE_ADDRESS: ProductionOracle contract address
    - CONSUMPTION_ORACLE_ADDRESS: ConsumptionOracle contract address
    
    Args:
        web3: Web3 instance
        
    Returns:
        Configured ClaimSubmitter
    """
    private_key = os.getenv("VERIFIER_PRIVATE_KEY")
    if not private_key:
        raise ValueError("VERIFIER_PRIVATE_KEY environment variable required")
    
    production_oracle = os.getenv("PRODUCTION_ORACLE_ADDRESS")
    if not production_oracle:
        raise ValueError("PRODUCTION_ORACLE_ADDRESS environment variable required")
    
    consumption_oracle = os.getenv("CONSUMPTION_ORACLE_ADDRESS")
    if not consumption_oracle:
        raise ValueError("CONSUMPTION_ORACLE_ADDRESS environment variable required")
    
    signer = ClaimSigner(private_key)
    
    return ClaimSubmitter(
        web3=web3,
        signer=signer,
        production_oracle_address=production_oracle,
        consumption_oracle_address=consumption_oracle
    )
