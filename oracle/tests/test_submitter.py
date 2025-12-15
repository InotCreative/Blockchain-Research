"""
Tests for Claim Submitter.

Requirements: 9.3, 9.4
"""

import pytest
from unittest.mock import Mock, MagicMock, patch
from eth_account import Account

import sys
import os
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.dirname(__file__))))

from oracle.submitter import (
    ClaimSigner,
    ClaimSubmitter,
    ClaimData,
    ClaimType,
    SubmissionResult,
)


class TestClaimSigner:
    """Tests for ClaimSigner."""
    
    @pytest.fixture
    def signer(self):
        """Create a signer with a test private key."""
        # Generate a test account
        account = Account.create()
        return ClaimSigner(account.key.hex())
    
    def test_signer_initialization(self, signer):
        """Test signer initializes correctly."""
        assert signer.address is not None
        assert signer.address.startswith('0x')
        assert len(signer.address) == 42
    
    def test_signer_with_0x_prefix(self):
        """Test signer handles 0x prefix."""
        account = Account.create()
        signer = ClaimSigner('0x' + account.key.hex())
        assert signer.address == account.address
    
    def test_signer_without_0x_prefix(self):
        """Test signer handles missing 0x prefix."""
        account = Account.create()
        signer = ClaimSigner(account.key.hex())
        assert signer.address == account.address
    
    def test_sign_claim(self, signer):
        """Test signing a claim."""
        claim = ClaimData(
            subject_id="0x" + "ab" * 32,
            hour_id=500000,
            energy_wh=5000,
            evidence_root="0x" + "cd" * 32
        )
        
        signature = signer.sign_claim(
            chain_id=31337,
            contract_address="0x1234567890123456789012345678901234567890",
            claim=claim
        )
        
        assert signature is not None
        assert len(signature) == 65  # r (32) + s (32) + v (1)
    
    def test_sign_claim_deterministic(self, signer):
        """Test that signing is deterministic."""
        claim = ClaimData(
            subject_id="0x" + "ab" * 32,
            hour_id=500000,
            energy_wh=5000,
            evidence_root="0x" + "cd" * 32
        )
        
        sig1 = signer.sign_claim(31337, "0x1234567890123456789012345678901234567890", claim)
        sig2 = signer.sign_claim(31337, "0x1234567890123456789012345678901234567890", claim)
        
        assert sig1 == sig2
    
    def test_sign_claim_different_chain_id(self, signer):
        """Test that different chain IDs produce different signatures."""
        claim = ClaimData(
            subject_id="0x" + "ab" * 32,
            hour_id=500000,
            energy_wh=5000,
            evidence_root="0x" + "cd" * 32
        )
        
        sig1 = signer.sign_claim(31337, "0x1234567890123456789012345678901234567890", claim)
        sig2 = signer.sign_claim(1, "0x1234567890123456789012345678901234567890", claim)
        
        assert sig1 != sig2
    
    def test_sign_claim_different_contract(self, signer):
        """Test that different contracts produce different signatures."""
        claim = ClaimData(
            subject_id="0x" + "ab" * 32,
            hour_id=500000,
            energy_wh=5000,
            evidence_root="0x" + "cd" * 32
        )
        
        sig1 = signer.sign_claim(31337, "0x1111111111111111111111111111111111111111", claim)
        sig2 = signer.sign_claim(31337, "0x2222222222222222222222222222222222222222", claim)
        
        assert sig1 != sig2
    
    def test_message_hash_format(self, signer):
        """Test message hash computation."""
        message_hash = signer._build_message_hash(
            chain_id=31337,
            contract_address="0x1234567890123456789012345678901234567890",
            subject_id="0x" + "ab" * 32,
            hour_id=500000,
            energy_wh=5000,
            evidence_root="0x" + "cd" * 32
        )
        
        assert len(message_hash) == 32  # keccak256 output


class TestClaimSubmitter:
    """Tests for ClaimSubmitter."""
    
    @pytest.fixture
    def mock_web3(self):
        """Create a mock Web3 instance."""
        web3 = MagicMock()
        web3.eth.chain_id = 31337
        web3.eth.gas_price = 1000000000
        web3.eth.get_transaction_count.return_value = 0
        return web3
    
    @pytest.fixture
    def signer(self):
        """Create a test signer."""
        account = Account.create()
        return ClaimSigner(account.key.hex())
    
    @pytest.fixture
    def submitter(self, mock_web3, signer):
        """Create a ClaimSubmitter with mocks."""
        return ClaimSubmitter(
            web3=mock_web3,
            signer=signer,
            production_oracle_address="0x1111111111111111111111111111111111111111",
            consumption_oracle_address="0x2222222222222222222222222222222222222222"
        )
    
    def test_submitter_initialization(self, submitter):
        """Test submitter initializes correctly."""
        assert submitter.chain_id == 31337
        assert submitter.production_oracle is not None
        assert submitter.consumption_oracle is not None
    
    def test_get_claim_key_production(self, submitter):
        """Test getting claim key for production."""
        subject_id = "0x" + "ab" * 32
        hour_id = 500000
        
        # Mock the contract call
        submitter.production_oracle.functions.getClaimKey.return_value.call.return_value = bytes.fromhex("cd" * 32)
        
        claim_key = submitter.get_claim_key(subject_id, hour_id, ClaimType.PRODUCTION)
        
        assert claim_key.startswith('0x')
        assert len(claim_key) == 66
    
    def test_get_claim_key_consumption(self, submitter):
        """Test getting claim key for consumption."""
        subject_id = "0x" + "ab" * 32
        hour_id = 500000
        
        # Mock the contract call
        submitter.consumption_oracle.functions.getClaimKey.return_value.call.return_value = bytes.fromhex("cd" * 32)
        
        claim_key = submitter.get_claim_key(subject_id, hour_id, ClaimType.CONSUMPTION)
        
        assert claim_key.startswith('0x')
    
    def test_has_submitted_false(self, submitter):
        """Test checking submission status when not submitted."""
        subject_id = "0x" + "ab" * 32
        hour_id = 500000
        
        # Mock the contract calls
        submitter.production_oracle.functions.getClaimKey.return_value.call.return_value = bytes.fromhex("cd" * 32)
        submitter.production_oracle.functions.hasSubmitted.return_value.call.return_value = False
        
        result = submitter.has_submitted(subject_id, hour_id, ClaimType.PRODUCTION)
        
        assert result is False
    
    def test_has_submitted_true(self, submitter):
        """Test checking submission status when already submitted."""
        subject_id = "0x" + "ab" * 32
        hour_id = 500000
        
        # Mock the contract calls
        submitter.production_oracle.functions.getClaimKey.return_value.call.return_value = bytes.fromhex("cd" * 32)
        submitter.production_oracle.functions.hasSubmitted.return_value.call.return_value = True
        
        result = submitter.has_submitted(subject_id, hour_id, ClaimType.PRODUCTION)
        
        assert result is True
    
    def test_is_finalized(self, submitter):
        """Test checking if claim is finalized."""
        subject_id = "0x" + "ab" * 32
        hour_id = 500000
        
        # Mock the contract calls
        submitter.production_oracle.functions.getClaimKey.return_value.call.return_value = bytes.fromhex("cd" * 32)
        submitter.production_oracle.functions.isFinalized.return_value.call.return_value = True
        
        result = submitter.is_finalized(subject_id, hour_id, ClaimType.PRODUCTION)
        
        assert result is True


class TestSubmissionResult:
    """Tests for SubmissionResult dataclass."""
    
    def test_successful_result(self):
        """Test creating a successful result."""
        result = SubmissionResult(
            success=True,
            tx_hash="0x" + "ab" * 32,
            gas_used=100000,
            block_number=12345
        )
        
        assert result.success is True
        assert result.tx_hash is not None
        assert result.error is None
    
    def test_failed_result(self):
        """Test creating a failed result."""
        result = SubmissionResult(
            success=False,
            error="Transaction reverted"
        )
        
        assert result.success is False
        assert result.error == "Transaction reverted"
        assert result.tx_hash is None


class TestClaimData:
    """Tests for ClaimData dataclass."""
    
    def test_claim_data_creation(self):
        """Test creating claim data."""
        claim = ClaimData(
            subject_id="0x" + "ab" * 32,
            hour_id=500000,
            energy_wh=5000,
            evidence_root="0x" + "cd" * 32
        )
        
        assert claim.subject_id == "0x" + "ab" * 32
        assert claim.hour_id == 500000
        assert claim.energy_wh == 5000
        assert claim.evidence_root == "0x" + "cd" * 32


if __name__ == "__main__":
    pytest.main([__file__, "-v"])
