"""
Keeper/Finalizer Service for SEARChain Oracle.

This module monitors expired claim windows and calls finalizeProduction/finalizeConsumption
on the oracle contracts. It acts as a keeper service to ensure claims are finalized
after their deadlines pass.

Requirements: 4.3, 5.2
"""

import os
import time
import logging
from typing import Dict, List, Optional, Any, Tuple
from dataclasses import dataclass
from enum import Enum

from web3 import Web3
from web3.exceptions import ContractLogicError, TransactionNotFound, TimeExhausted
from web3.types import TxReceipt

# Configure logging
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)


class ClaimType(Enum):
    """Claim type for domain separation."""
    PRODUCTION = 0x01
    CONSUMPTION = 0x02


@dataclass
class PendingClaim:
    """Represents a pending claim that may need finalization."""
    claim_key: str
    subject_id: str  # producerId or consumerId
    hour_id: int
    claim_type: ClaimType
    deadline: int
    snapshot_id: int
    finalized: bool
    disputed: bool


@dataclass
class FinalizationResult:
    """Result of a finalization attempt."""
    success: bool
    claim_key: str
    tx_hash: Optional[str] = None
    error: Optional[str] = None
    gas_used: Optional[int] = None
    block_number: Optional[int] = None
    already_finalized: bool = False
    disputed: bool = False


class ClaimFinalizer:
    """
    Finalizes expired claims on ProductionOracle and ConsumptionOracle contracts.
    
    Monitors claim buckets and calls finalize functions after deadlines pass.
    Handles transaction errors and retries.
    """
    
    # Production Oracle ABI (minimal for finalization)
    PRODUCTION_ORACLE_ABI = [
        {
            "inputs": [
                {"name": "producerId", "type": "bytes32"},
                {"name": "hourId", "type": "uint256"}
            ],
            "name": "finalizeProduction",
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
            "inputs": [{"name": "claimKey", "type": "bytes32"}],
            "name": "getClaimBucket",
            "outputs": [
                {
                    "components": [
                        {"name": "deadline", "type": "uint256"},
                        {"name": "snapshotId", "type": "uint256"},
                        {"name": "submissionCount", "type": "uint32"},
                        {"name": "finalized", "type": "bool"},
                        {"name": "disputed", "type": "bool"},
                        {"name": "verifiedEnergyWh", "type": "uint64"},
                        {"name": "maxSubmittedEnergyWh", "type": "uint64"},
                        {"name": "winningValueHash", "type": "bytes32"},
                        {"name": "evidenceRoot", "type": "bytes32"},
                        {"name": "allSubmittersBitmap", "type": "uint16"},
                        {"name": "winningVerifierBitmap", "type": "uint16"}
                    ],
                    "name": "",
                    "type": "tuple"
                }
            ],
            "stateMutability": "view",
            "type": "function"
        }
    ]
    
    # Consumption Oracle ABI (minimal for finalization)
    CONSUMPTION_ORACLE_ABI = [
        {
            "inputs": [
                {"name": "consumerId", "type": "bytes32"},
                {"name": "hourId", "type": "uint256"}
            ],
            "name": "finalizeConsumption",
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
            "inputs": [{"name": "claimKey", "type": "bytes32"}],
            "name": "getClaimBucket",
            "outputs": [
                {
                    "components": [
                        {"name": "deadline", "type": "uint256"},
                        {"name": "snapshotId", "type": "uint256"},
                        {"name": "submissionCount", "type": "uint32"},
                        {"name": "finalized", "type": "bool"},
                        {"name": "disputed", "type": "bool"},
                        {"name": "verifiedEnergyWh", "type": "uint64"},
                        {"name": "maxSubmittedEnergyWh", "type": "uint64"},
                        {"name": "winningValueHash", "type": "bytes32"},
                        {"name": "evidenceRoot", "type": "bytes32"},
                        {"name": "allSubmittersBitmap", "type": "uint16"},
                        {"name": "winningVerifierBitmap", "type": "uint16"}
                    ],
                    "name": "",
                    "type": "tuple"
                }
            ],
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
        finalizer_private_key: str,
        production_oracle_address: str,
        consumption_oracle_address: str,
        gas_limit: int = DEFAULT_GAS_LIMIT,
        max_retries: int = DEFAULT_MAX_RETRIES,
        retry_delay: int = DEFAULT_RETRY_DELAY,
        confirmation_timeout: int = DEFAULT_CONFIRMATION_TIMEOUT
    ):
        """
        Initialize claim finalizer.
        
        Args:
            web3: Web3 instance
            finalizer_private_key: Private key for sending transactions
            production_oracle_address: ProductionOracle contract address
            consumption_oracle_address: ConsumptionOracle contract address
            gas_limit: Gas limit for transactions
            max_retries: Maximum retry attempts
            retry_delay: Delay between retries in seconds
            confirmation_timeout: Timeout for transaction confirmation
        """
        self.web3 = web3
        self.gas_limit = gas_limit
        self.max_retries = max_retries
        self.retry_delay = retry_delay
        self.confirmation_timeout = confirmation_timeout
        
        # Set up account
        if not finalizer_private_key.startswith('0x'):
            finalizer_private_key = '0x' + finalizer_private_key
        self.account = self.web3.eth.account.from_key(finalizer_private_key)
        self.address = self.account.address
        
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


    def get_claim_bucket(
        self,
        subject_id: str,
        hour_id: int,
        claim_type: ClaimType
    ) -> Optional[Dict[str, Any]]:
        """
        Get claim bucket details from the appropriate oracle.
        
        Args:
            subject_id: Producer or consumer ID (bytes32 hex)
            hour_id: Hour identifier
            claim_type: Type of claim
            
        Returns:
            Claim bucket dict or None if not found
        """
        subject_bytes = bytes.fromhex(
            subject_id[2:] if subject_id.startswith('0x') else subject_id
        )
        
        contract = (
            self.production_oracle if claim_type == ClaimType.PRODUCTION
            else self.consumption_oracle
        )
        
        try:
            claim_key = contract.functions.getClaimKey(subject_bytes, hour_id).call()
            bucket = contract.functions.getClaimBucket(claim_key).call()
            
            return {
                'claim_key': '0x' + claim_key.hex(),
                'deadline': bucket[0],
                'snapshot_id': bucket[1],
                'submission_count': bucket[2],
                'finalized': bucket[3],
                'disputed': bucket[4],
                'verified_energy_wh': bucket[5],
                'max_submitted_energy_wh': bucket[6],
                'winning_value_hash': '0x' + bucket[7].hex(),
                'evidence_root': '0x' + bucket[8].hex(),
                'all_submitters_bitmap': bucket[9],
                'winning_verifier_bitmap': bucket[10]
            }
        except Exception as e:
            logger.error(f"Failed to get claim bucket: {e}")
            return None

    def is_claim_expired(
        self,
        subject_id: str,
        hour_id: int,
        claim_type: ClaimType
    ) -> Tuple[bool, Optional[Dict[str, Any]]]:
        """
        Check if a claim's deadline has passed and it's ready for finalization.
        
        Args:
            subject_id: Producer or consumer ID
            hour_id: Hour identifier
            claim_type: Type of claim
            
        Returns:
            Tuple of (is_expired, claim_bucket)
        """
        bucket = self.get_claim_bucket(subject_id, hour_id, claim_type)
        
        if bucket is None:
            return False, None
        
        # Check if already finalized
        if bucket['finalized']:
            return False, bucket
        
        # Check if deadline has passed (deadline > 0 means claim was started)
        if bucket['deadline'] == 0:
            return False, bucket
        
        current_time = self.web3.eth.get_block('latest')['timestamp']
        is_expired = current_time > bucket['deadline']
        
        return is_expired, bucket

    def finalize_production(
        self,
        producer_id: str,
        hour_id: int
    ) -> FinalizationResult:
        """
        Finalize a production claim.
        
        Args:
            producer_id: Producer identifier (bytes32 hex)
            hour_id: Hour identifier
            
        Returns:
            FinalizationResult with transaction details
        """
        return self._finalize_claim(
            producer_id,
            hour_id,
            ClaimType.PRODUCTION,
            self.production_oracle,
            "finalizeProduction"
        )

    def finalize_consumption(
        self,
        consumer_id: str,
        hour_id: int
    ) -> FinalizationResult:
        """
        Finalize a consumption claim.
        
        Args:
            consumer_id: Consumer identifier (bytes32 hex)
            hour_id: Hour identifier
            
        Returns:
            FinalizationResult with transaction details
        """
        return self._finalize_claim(
            consumer_id,
            hour_id,
            ClaimType.CONSUMPTION,
            self.consumption_oracle,
            "finalizeConsumption"
        )

    def _finalize_claim(
        self,
        subject_id: str,
        hour_id: int,
        claim_type: ClaimType,
        contract: Any,
        method_name: str
    ) -> FinalizationResult:
        """
        Internal method to finalize a claim.
        
        Args:
            subject_id: Producer or consumer ID
            hour_id: Hour identifier
            claim_type: Type of claim
            contract: Contract instance
            method_name: Contract method to call
            
        Returns:
            FinalizationResult
        """
        subject_bytes = bytes.fromhex(
            subject_id[2:] if subject_id.startswith('0x') else subject_id
        )
        
        # Get claim key for result
        claim_key = contract.functions.getClaimKey(subject_bytes, hour_id).call()
        claim_key_hex = '0x' + claim_key.hex()
        
        # Check if already finalized
        if contract.functions.isFinalized(claim_key).call():
            return FinalizationResult(
                success=True,
                claim_key=claim_key_hex,
                already_finalized=True
            )
        
        # Check if deadline has passed
        bucket = contract.functions.getClaimBucket(claim_key).call()
        deadline = bucket[0]
        
        if deadline == 0:
            return FinalizationResult(
                success=False,
                claim_key=claim_key_hex,
                error="No submissions for this claim"
            )
        
        current_time = self.web3.eth.get_block('latest')['timestamp']
        if current_time <= deadline:
            return FinalizationResult(
                success=False,
                claim_key=claim_key_hex,
                error=f"Deadline not reached. Current: {current_time}, Deadline: {deadline}"
            )
        
        # Get the contract function
        contract_func = getattr(contract.functions, method_name)
        
        # Retry loop
        for attempt in range(self.max_retries):
            try:
                # Get current nonce
                nonce = self.web3.eth.get_transaction_count(self.address)
                
                # Build transaction
                tx = contract_func(
                    subject_bytes,
                    hour_id
                ).build_transaction({
                    'from': self.address,
                    'gas': self.gas_limit,
                    'gasPrice': self.web3.eth.gas_price,
                    'nonce': nonce,
                    'chainId': self.chain_id
                })
                
                # Sign and send
                signed_tx = self.web3.eth.account.sign_transaction(
                    tx,
                    self.account.key
                )
                tx_hash = self.web3.eth.send_raw_transaction(signed_tx.raw_transaction)
                
                logger.info(f"Finalization tx sent: {tx_hash.hex()}")
                
                # Wait for confirmation
                receipt = self._wait_for_confirmation(tx_hash)
                
                if receipt['status'] == 1:
                    # Check if claim entered disputed state
                    bucket_after = contract.functions.getClaimBucket(claim_key).call()
                    disputed = bucket_after[4]
                    
                    return FinalizationResult(
                        success=True,
                        claim_key=claim_key_hex,
                        tx_hash=tx_hash.hex(),
                        gas_used=receipt['gasUsed'],
                        block_number=receipt['blockNumber'],
                        disputed=disputed
                    )
                else:
                    return FinalizationResult(
                        success=False,
                        claim_key=claim_key_hex,
                        tx_hash=tx_hash.hex(),
                        error="Transaction reverted"
                    )
                    
            except ContractLogicError as e:
                error_msg = str(e)
                logger.warning(f"Contract error on attempt {attempt + 1}: {error_msg}")
                
                # Check for specific revert reasons
                if "ClaimAlreadyFinalized" in error_msg:
                    return FinalizationResult(
                        success=True,
                        claim_key=claim_key_hex,
                        already_finalized=True
                    )
                elif "ClaimDeadlineNotReached" in error_msg:
                    return FinalizationResult(
                        success=False,
                        claim_key=claim_key_hex,
                        error="Deadline not reached"
                    )
                
                if attempt < self.max_retries - 1:
                    time.sleep(self.retry_delay)
                else:
                    return FinalizationResult(
                        success=False,
                        claim_key=claim_key_hex,
                        error=error_msg
                    )
                    
            except Exception as e:
                logger.warning(f"Finalization attempt {attempt + 1} failed: {e}")
                if attempt < self.max_retries - 1:
                    time.sleep(self.retry_delay)
                else:
                    return FinalizationResult(
                        success=False,
                        claim_key=claim_key_hex,
                        error=str(e)
                    )
        
        return FinalizationResult(
            success=False,
            claim_key=claim_key_hex,
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



class FinalizerService:
    """
    Service that continuously monitors and finalizes expired claims.
    
    Tracks pending claims and automatically finalizes them when their
    deadlines pass.
    """
    
    DEFAULT_POLL_INTERVAL = 10  # seconds
    
    def __init__(
        self,
        finalizer: ClaimFinalizer,
        poll_interval: int = DEFAULT_POLL_INTERVAL
    ):
        """
        Initialize finalizer service.
        
        Args:
            finalizer: ClaimFinalizer instance
            poll_interval: Interval between polling cycles in seconds
        """
        self.finalizer = finalizer
        self.poll_interval = poll_interval
        
        # Track pending claims to monitor
        self._pending_production: Dict[str, PendingClaim] = {}
        self._pending_consumption: Dict[str, PendingClaim] = {}
        
        # Track finalization results
        self._results: List[FinalizationResult] = []
        
        self._running = False

    def add_pending_production(
        self,
        producer_id: str,
        hour_id: int
    ) -> Optional[PendingClaim]:
        """
        Add a production claim to monitor for finalization.
        
        Args:
            producer_id: Producer identifier
            hour_id: Hour identifier
            
        Returns:
            PendingClaim if added, None if already finalized
        """
        bucket = self.finalizer.get_claim_bucket(
            producer_id, hour_id, ClaimType.PRODUCTION
        )
        
        if bucket is None or bucket['finalized']:
            return None
        
        claim = PendingClaim(
            claim_key=bucket['claim_key'],
            subject_id=producer_id,
            hour_id=hour_id,
            claim_type=ClaimType.PRODUCTION,
            deadline=bucket['deadline'],
            snapshot_id=bucket['snapshot_id'],
            finalized=bucket['finalized'],
            disputed=bucket['disputed']
        )
        
        self._pending_production[bucket['claim_key']] = claim
        logger.info(f"Added pending production claim: {bucket['claim_key']}")
        return claim

    def add_pending_consumption(
        self,
        consumer_id: str,
        hour_id: int
    ) -> Optional[PendingClaim]:
        """
        Add a consumption claim to monitor for finalization.
        
        Args:
            consumer_id: Consumer identifier
            hour_id: Hour identifier
            
        Returns:
            PendingClaim if added, None if already finalized
        """
        bucket = self.finalizer.get_claim_bucket(
            consumer_id, hour_id, ClaimType.CONSUMPTION
        )
        
        if bucket is None or bucket['finalized']:
            return None
        
        claim = PendingClaim(
            claim_key=bucket['claim_key'],
            subject_id=consumer_id,
            hour_id=hour_id,
            claim_type=ClaimType.CONSUMPTION,
            deadline=bucket['deadline'],
            snapshot_id=bucket['snapshot_id'],
            finalized=bucket['finalized'],
            disputed=bucket['disputed']
        )
        
        self._pending_consumption[bucket['claim_key']] = claim
        logger.info(f"Added pending consumption claim: {bucket['claim_key']}")
        return claim

    def check_and_finalize_expired(self) -> List[FinalizationResult]:
        """
        Check all pending claims and finalize any that have expired.
        
        Returns:
            List of finalization results for this cycle
        """
        results = []
        current_time = self.finalizer.web3.eth.get_block('latest')['timestamp']
        
        # Check production claims
        finalized_production = []
        for claim_key, claim in self._pending_production.items():
            if claim.deadline > 0 and current_time > claim.deadline:
                logger.info(f"Finalizing expired production claim: {claim_key}")
                result = self.finalizer.finalize_production(
                    claim.subject_id,
                    claim.hour_id
                )
                results.append(result)
                self._results.append(result)
                
                if result.success or result.already_finalized:
                    finalized_production.append(claim_key)
        
        # Remove finalized production claims
        for claim_key in finalized_production:
            del self._pending_production[claim_key]
        
        # Check consumption claims
        finalized_consumption = []
        for claim_key, claim in self._pending_consumption.items():
            if claim.deadline > 0 and current_time > claim.deadline:
                logger.info(f"Finalizing expired consumption claim: {claim_key}")
                result = self.finalizer.finalize_consumption(
                    claim.subject_id,
                    claim.hour_id
                )
                results.append(result)
                self._results.append(result)
                
                if result.success or result.already_finalized:
                    finalized_consumption.append(claim_key)
        
        # Remove finalized consumption claims
        for claim_key in finalized_consumption:
            del self._pending_consumption[claim_key]
        
        return results

    def get_pending_count(self) -> Tuple[int, int]:
        """
        Get count of pending claims.
        
        Returns:
            Tuple of (production_count, consumption_count)
        """
        return len(self._pending_production), len(self._pending_consumption)

    def get_results(self) -> List[FinalizationResult]:
        """
        Get all finalization results.
        
        Returns:
            List of all finalization results
        """
        return self._results.copy()

    def clear_results(self) -> None:
        """Clear stored finalization results."""
        self._results.clear()

    def run_once(self) -> List[FinalizationResult]:
        """
        Run a single finalization cycle.
        
        Returns:
            List of finalization results
        """
        return self.check_and_finalize_expired()

    def start(self) -> None:
        """
        Start the continuous finalization loop.
        
        Note: This is a blocking call. For production use, run in a separate thread.
        """
        self._running = True
        logger.info("Finalizer service started")
        
        while self._running:
            try:
                results = self.check_and_finalize_expired()
                if results:
                    logger.info(f"Finalized {len(results)} claims this cycle")
            except Exception as e:
                logger.error(f"Error in finalization cycle: {e}")
            
            time.sleep(self.poll_interval)

    def stop(self) -> None:
        """Stop the finalization loop."""
        self._running = False
        logger.info("Finalizer service stopped")


def create_finalizer_from_env(web3: Web3) -> ClaimFinalizer:
    """
    Create a ClaimFinalizer from environment variables.
    
    Required env vars:
    - FINALIZER_PRIVATE_KEY: Private key for sending transactions
    - PRODUCTION_ORACLE_ADDRESS: ProductionOracle contract address
    - CONSUMPTION_ORACLE_ADDRESS: ConsumptionOracle contract address
    
    Args:
        web3: Web3 instance
        
    Returns:
        Configured ClaimFinalizer
    """
    private_key = os.getenv("FINALIZER_PRIVATE_KEY")
    if not private_key:
        raise ValueError("FINALIZER_PRIVATE_KEY environment variable required")
    
    production_oracle = os.getenv("PRODUCTION_ORACLE_ADDRESS")
    if not production_oracle:
        raise ValueError("PRODUCTION_ORACLE_ADDRESS environment variable required")
    
    consumption_oracle = os.getenv("CONSUMPTION_ORACLE_ADDRESS")
    if not consumption_oracle:
        raise ValueError("CONSUMPTION_ORACLE_ADDRESS environment variable required")
    
    return ClaimFinalizer(
        web3=web3,
        finalizer_private_key=private_key,
        production_oracle_address=production_oracle,
        consumption_oracle_address=consumption_oracle
    )


def create_service_from_env(web3: Web3) -> FinalizerService:
    """
    Create a FinalizerService from environment variables.
    
    Args:
        web3: Web3 instance
        
    Returns:
        Configured FinalizerService
    """
    finalizer = create_finalizer_from_env(web3)
    
    poll_interval = int(os.getenv("FINALIZER_POLL_INTERVAL", "10"))
    
    return FinalizerService(
        finalizer=finalizer,
        poll_interval=poll_interval
    )
