"""
Tests for Keeper/Finalizer Service.

Requirements: 4.3, 5.2
"""

import pytest
from unittest.mock import Mock, MagicMock, patch
from eth_account import Account

import sys
import os
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.dirname(__file__))))

from oracle.finalizer import (
    ClaimFinalizer,
    FinalizerService,
    ClaimType,
    PendingClaim,
    FinalizationResult,
    create_finalizer_from_env,
    create_service_from_env,
)


class TestClaimFinalizer:
    """Tests for ClaimFinalizer."""
    
    @pytest.fixture
    def mock_web3(self):
        """Create a mock Web3 instance."""
        web3 = MagicMock()
        web3.eth.chain_id = 31337
        web3.eth.gas_price = 1000000000
        web3.eth.get_transaction_count.return_value = 0
        web3.eth.get_block.return_value = {'timestamp': 1700000000}
        return web3
    
    @pytest.fixture
    def finalizer(self, mock_web3):
        """Create a ClaimFinalizer with mocks."""
        account = Account.create()
        return ClaimFinalizer(
            web3=mock_web3,
            finalizer_private_key=account.key.hex(),
            production_oracle_address="0x1111111111111111111111111111111111111111",
            consumption_oracle_address="0x2222222222222222222222222222222222222222"
        )
    
    def test_finalizer_initialization(self, finalizer):
        """Test finalizer initializes correctly."""
        assert finalizer.chain_id == 31337
        assert finalizer.production_oracle is not None
        assert finalizer.consumption_oracle is not None
        assert finalizer.address is not None
        assert finalizer.address.startswith('0x')
    
    def test_finalizer_with_0x_prefix(self, mock_web3):
        """Test finalizer handles 0x prefix in private key."""
        account = Account.create()
        finalizer = ClaimFinalizer(
            web3=mock_web3,
            finalizer_private_key='0x' + account.key.hex(),
            production_oracle_address="0x1111111111111111111111111111111111111111",
            consumption_oracle_address="0x2222222222222222222222222222222222222222"
        )
        # Verify the address is set (it's derived from the private key internally)
        assert finalizer.address is not None
        assert finalizer.address.startswith('0x')
    
    def test_finalizer_without_0x_prefix(self, mock_web3):
        """Test finalizer handles missing 0x prefix in private key."""
        account = Account.create()
        finalizer = ClaimFinalizer(
            web3=mock_web3,
            finalizer_private_key=account.key.hex(),
            production_oracle_address="0x1111111111111111111111111111111111111111",
            consumption_oracle_address="0x2222222222222222222222222222222222222222"
        )
        # Verify the address is set (it's derived from the private key internally)
        assert finalizer.address is not None
        assert finalizer.address.startswith('0x')


class TestGetClaimBucket:
    """Tests for get_claim_bucket method."""
    
    @pytest.fixture
    def mock_web3(self):
        """Create a mock Web3 instance."""
        web3 = MagicMock()
        web3.eth.chain_id = 31337
        web3.eth.gas_price = 1000000000
        web3.eth.get_transaction_count.return_value = 0
        web3.eth.get_block.return_value = {'timestamp': 1700000000}
        return web3
    
    @pytest.fixture
    def finalizer(self, mock_web3):
        """Create a ClaimFinalizer with mocks."""
        account = Account.create()
        return ClaimFinalizer(
            web3=mock_web3,
            finalizer_private_key=account.key.hex(),
            production_oracle_address="0x1111111111111111111111111111111111111111",
            consumption_oracle_address="0x2222222222222222222222222222222222222222"
        )
    
    def test_get_claim_bucket_production(self, finalizer):
        """Test getting claim bucket for production."""
        subject_id = "0x" + "ab" * 32
        hour_id = 500000
        
        # Mock the contract calls
        claim_key_bytes = bytes.fromhex("cd" * 32)
        finalizer.production_oracle.functions.getClaimKey.return_value.call.return_value = claim_key_bytes
        
        # Mock bucket tuple (matches ClaimBucket struct)
        mock_bucket = (
            1700000100,  # deadline
            1,           # snapshotId
            3,           # submissionCount
            False,       # finalized
            False,       # disputed
            5000,        # verifiedEnergyWh
            6000,        # maxSubmittedEnergyWh
            bytes.fromhex("ef" * 32),  # winningValueHash
            bytes.fromhex("12" * 32),  # evidenceRoot
            7,           # allSubmittersBitmap
            5,           # winningVerifierBitmap
        )
        finalizer.production_oracle.functions.getClaimBucket.return_value.call.return_value = mock_bucket
        
        bucket = finalizer.get_claim_bucket(subject_id, hour_id, ClaimType.PRODUCTION)
        
        assert bucket is not None
        assert bucket['deadline'] == 1700000100
        assert bucket['snapshot_id'] == 1
        assert bucket['submission_count'] == 3
        assert bucket['finalized'] is False
        assert bucket['disputed'] is False
        assert bucket['verified_energy_wh'] == 5000
    
    def test_get_claim_bucket_consumption(self, finalizer):
        """Test getting claim bucket for consumption."""
        subject_id = "0x" + "ab" * 32
        hour_id = 500000
        
        # Mock the contract calls
        claim_key_bytes = bytes.fromhex("cd" * 32)
        finalizer.consumption_oracle.functions.getClaimKey.return_value.call.return_value = claim_key_bytes
        
        mock_bucket = (
            1700000100, 1, 3, False, False, 5000, 6000,
            bytes.fromhex("ef" * 32), bytes.fromhex("12" * 32), 7, 5
        )
        finalizer.consumption_oracle.functions.getClaimBucket.return_value.call.return_value = mock_bucket
        
        bucket = finalizer.get_claim_bucket(subject_id, hour_id, ClaimType.CONSUMPTION)
        
        assert bucket is not None
        assert bucket['deadline'] == 1700000100
    
    def test_get_claim_bucket_error(self, finalizer):
        """Test get_claim_bucket handles errors gracefully."""
        subject_id = "0x" + "ab" * 32
        hour_id = 500000
        
        # Mock an error
        finalizer.production_oracle.functions.getClaimKey.return_value.call.side_effect = Exception("Contract error")
        
        bucket = finalizer.get_claim_bucket(subject_id, hour_id, ClaimType.PRODUCTION)
        
        assert bucket is None



class TestIsClaimExpired:
    """Tests for is_claim_expired method."""
    
    @pytest.fixture
    def mock_web3(self):
        """Create a mock Web3 instance."""
        web3 = MagicMock()
        web3.eth.chain_id = 31337
        web3.eth.gas_price = 1000000000
        web3.eth.get_transaction_count.return_value = 0
        return web3
    
    @pytest.fixture
    def finalizer(self, mock_web3):
        """Create a ClaimFinalizer with mocks."""
        account = Account.create()
        return ClaimFinalizer(
            web3=mock_web3,
            finalizer_private_key=account.key.hex(),
            production_oracle_address="0x1111111111111111111111111111111111111111",
            consumption_oracle_address="0x2222222222222222222222222222222222222222"
        )
    
    def test_claim_expired(self, finalizer):
        """Test detecting an expired claim."""
        subject_id = "0x" + "ab" * 32
        hour_id = 500000
        
        # Set current time after deadline
        finalizer.web3.eth.get_block.return_value = {'timestamp': 1700000200}
        
        # Mock bucket with deadline in the past
        claim_key_bytes = bytes.fromhex("cd" * 32)
        finalizer.production_oracle.functions.getClaimKey.return_value.call.return_value = claim_key_bytes
        
        mock_bucket = (
            1700000100,  # deadline (in the past)
            1, 3, False, False, 5000, 6000,
            bytes.fromhex("ef" * 32), bytes.fromhex("12" * 32), 7, 5
        )
        finalizer.production_oracle.functions.getClaimBucket.return_value.call.return_value = mock_bucket
        
        is_expired, bucket = finalizer.is_claim_expired(subject_id, hour_id, ClaimType.PRODUCTION)
        
        assert is_expired is True
        assert bucket is not None
    
    def test_claim_not_expired(self, finalizer):
        """Test detecting a non-expired claim."""
        subject_id = "0x" + "ab" * 32
        hour_id = 500000
        
        # Set current time before deadline
        finalizer.web3.eth.get_block.return_value = {'timestamp': 1700000050}
        
        claim_key_bytes = bytes.fromhex("cd" * 32)
        finalizer.production_oracle.functions.getClaimKey.return_value.call.return_value = claim_key_bytes
        
        mock_bucket = (
            1700000100,  # deadline (in the future)
            1, 3, False, False, 5000, 6000,
            bytes.fromhex("ef" * 32), bytes.fromhex("12" * 32), 7, 5
        )
        finalizer.production_oracle.functions.getClaimBucket.return_value.call.return_value = mock_bucket
        
        is_expired, bucket = finalizer.is_claim_expired(subject_id, hour_id, ClaimType.PRODUCTION)
        
        assert is_expired is False
        assert bucket is not None
    
    def test_claim_already_finalized(self, finalizer):
        """Test that finalized claims are not considered expired."""
        subject_id = "0x" + "ab" * 32
        hour_id = 500000
        
        finalizer.web3.eth.get_block.return_value = {'timestamp': 1700000200}
        
        claim_key_bytes = bytes.fromhex("cd" * 32)
        finalizer.production_oracle.functions.getClaimKey.return_value.call.return_value = claim_key_bytes
        
        mock_bucket = (
            1700000100, 1, 3,
            True,   # finalized
            False, 5000, 6000,
            bytes.fromhex("ef" * 32), bytes.fromhex("12" * 32), 7, 5
        )
        finalizer.production_oracle.functions.getClaimBucket.return_value.call.return_value = mock_bucket
        
        is_expired, bucket = finalizer.is_claim_expired(subject_id, hour_id, ClaimType.PRODUCTION)
        
        assert is_expired is False
        assert bucket['finalized'] is True
    
    def test_claim_no_submissions(self, finalizer):
        """Test claim with no submissions (deadline = 0)."""
        subject_id = "0x" + "ab" * 32
        hour_id = 500000
        
        finalizer.web3.eth.get_block.return_value = {'timestamp': 1700000200}
        
        claim_key_bytes = bytes.fromhex("cd" * 32)
        finalizer.production_oracle.functions.getClaimKey.return_value.call.return_value = claim_key_bytes
        
        mock_bucket = (
            0,  # deadline = 0 means no submissions
            0, 0, False, False, 0, 0,
            bytes.fromhex("00" * 32), bytes.fromhex("00" * 32), 0, 0
        )
        finalizer.production_oracle.functions.getClaimBucket.return_value.call.return_value = mock_bucket
        
        is_expired, bucket = finalizer.is_claim_expired(subject_id, hour_id, ClaimType.PRODUCTION)
        
        assert is_expired is False


class TestFinalizeProduction:
    """Tests for finalize_production method."""
    
    @pytest.fixture
    def mock_web3(self):
        """Create a mock Web3 instance."""
        web3 = MagicMock()
        web3.eth.chain_id = 31337
        web3.eth.gas_price = 1000000000
        web3.eth.get_transaction_count.return_value = 0
        web3.eth.get_block.return_value = {'timestamp': 1700000200}
        return web3
    
    @pytest.fixture
    def finalizer(self, mock_web3):
        """Create a ClaimFinalizer with mocks."""
        account = Account.create()
        return ClaimFinalizer(
            web3=mock_web3,
            finalizer_private_key=account.key.hex(),
            production_oracle_address="0x1111111111111111111111111111111111111111",
            consumption_oracle_address="0x2222222222222222222222222222222222222222"
        )
    
    def test_finalize_already_finalized(self, finalizer):
        """Test finalizing an already finalized claim."""
        producer_id = "0x" + "ab" * 32
        hour_id = 500000
        
        claim_key_bytes = bytes.fromhex("cd" * 32)
        finalizer.production_oracle.functions.getClaimKey.return_value.call.return_value = claim_key_bytes
        finalizer.production_oracle.functions.isFinalized.return_value.call.return_value = True
        
        result = finalizer.finalize_production(producer_id, hour_id)
        
        assert result.success is True
        assert result.already_finalized is True
        assert result.claim_key == "0x" + "cd" * 32
    
    def test_finalize_no_submissions(self, finalizer):
        """Test finalizing a claim with no submissions."""
        producer_id = "0x" + "ab" * 32
        hour_id = 500000
        
        claim_key_bytes = bytes.fromhex("cd" * 32)
        finalizer.production_oracle.functions.getClaimKey.return_value.call.return_value = claim_key_bytes
        finalizer.production_oracle.functions.isFinalized.return_value.call.return_value = False
        
        # Bucket with deadline = 0
        mock_bucket = (0, 0, 0, False, False, 0, 0,
                       bytes.fromhex("00" * 32), bytes.fromhex("00" * 32), 0, 0)
        finalizer.production_oracle.functions.getClaimBucket.return_value.call.return_value = mock_bucket
        
        result = finalizer.finalize_production(producer_id, hour_id)
        
        assert result.success is False
        assert "No submissions" in result.error
    
    def test_finalize_deadline_not_reached(self, finalizer):
        """Test finalizing before deadline."""
        producer_id = "0x" + "ab" * 32
        hour_id = 500000
        
        # Set current time before deadline
        finalizer.web3.eth.get_block.return_value = {'timestamp': 1700000050}
        
        claim_key_bytes = bytes.fromhex("cd" * 32)
        finalizer.production_oracle.functions.getClaimKey.return_value.call.return_value = claim_key_bytes
        finalizer.production_oracle.functions.isFinalized.return_value.call.return_value = False
        
        mock_bucket = (1700000100, 1, 3, False, False, 5000, 6000,
                       bytes.fromhex("ef" * 32), bytes.fromhex("12" * 32), 7, 5)
        finalizer.production_oracle.functions.getClaimBucket.return_value.call.return_value = mock_bucket
        
        result = finalizer.finalize_production(producer_id, hour_id)
        
        assert result.success is False
        assert "Deadline not reached" in result.error
    
    def test_finalize_success(self, finalizer):
        """Test successful finalization."""
        producer_id = "0x" + "ab" * 32
        hour_id = 500000
        
        claim_key_bytes = bytes.fromhex("cd" * 32)
        finalizer.production_oracle.functions.getClaimKey.return_value.call.return_value = claim_key_bytes
        finalizer.production_oracle.functions.isFinalized.return_value.call.return_value = False
        
        # Bucket with deadline in the past
        mock_bucket = (1700000100, 1, 3, False, False, 5000, 6000,
                       bytes.fromhex("ef" * 32), bytes.fromhex("12" * 32), 7, 5)
        finalizer.production_oracle.functions.getClaimBucket.return_value.call.return_value = mock_bucket
        
        # Mock transaction
        tx_hash = bytes.fromhex("aa" * 32)
        finalizer.web3.eth.send_raw_transaction.return_value = tx_hash
        finalizer.web3.eth.wait_for_transaction_receipt.return_value = {
            'status': 1,
            'gasUsed': 150000,
            'blockNumber': 12345
        }
        
        # After finalization, bucket shows finalized
        mock_bucket_after = (1700000100, 1, 3, True, False, 5000, 6000,
                             bytes.fromhex("ef" * 32), bytes.fromhex("12" * 32), 7, 5)
        finalizer.production_oracle.functions.getClaimBucket.return_value.call.side_effect = [
            mock_bucket, mock_bucket_after
        ]
        
        result = finalizer.finalize_production(producer_id, hour_id)
        
        assert result.success is True
        assert result.tx_hash is not None
        assert result.gas_used == 150000
        assert result.disputed is False



class TestFinalizeConsumption:
    """Tests for finalize_consumption method."""
    
    @pytest.fixture
    def mock_web3(self):
        """Create a mock Web3 instance."""
        web3 = MagicMock()
        web3.eth.chain_id = 31337
        web3.eth.gas_price = 1000000000
        web3.eth.get_transaction_count.return_value = 0
        web3.eth.get_block.return_value = {'timestamp': 1700000200}
        return web3
    
    @pytest.fixture
    def finalizer(self, mock_web3):
        """Create a ClaimFinalizer with mocks."""
        account = Account.create()
        return ClaimFinalizer(
            web3=mock_web3,
            finalizer_private_key=account.key.hex(),
            production_oracle_address="0x1111111111111111111111111111111111111111",
            consumption_oracle_address="0x2222222222222222222222222222222222222222"
        )
    
    def test_finalize_consumption_success(self, finalizer):
        """Test successful consumption finalization."""
        consumer_id = "0x" + "ab" * 32
        hour_id = 500000
        
        claim_key_bytes = bytes.fromhex("cd" * 32)
        finalizer.consumption_oracle.functions.getClaimKey.return_value.call.return_value = claim_key_bytes
        finalizer.consumption_oracle.functions.isFinalized.return_value.call.return_value = False
        
        mock_bucket = (1700000100, 1, 3, False, False, 5000, 6000,
                       bytes.fromhex("ef" * 32), bytes.fromhex("12" * 32), 7, 5)
        finalizer.consumption_oracle.functions.getClaimBucket.return_value.call.return_value = mock_bucket
        
        tx_hash = bytes.fromhex("aa" * 32)
        finalizer.web3.eth.send_raw_transaction.return_value = tx_hash
        finalizer.web3.eth.wait_for_transaction_receipt.return_value = {
            'status': 1,
            'gasUsed': 150000,
            'blockNumber': 12345
        }
        
        mock_bucket_after = (1700000100, 1, 3, True, False, 5000, 6000,
                             bytes.fromhex("ef" * 32), bytes.fromhex("12" * 32), 7, 5)
        finalizer.consumption_oracle.functions.getClaimBucket.return_value.call.side_effect = [
            mock_bucket, mock_bucket_after
        ]
        
        result = finalizer.finalize_consumption(consumer_id, hour_id)
        
        assert result.success is True
        assert result.tx_hash is not None
    
    def test_finalize_consumption_disputed(self, finalizer):
        """Test finalization that results in disputed state."""
        consumer_id = "0x" + "ab" * 32
        hour_id = 500000
        
        claim_key_bytes = bytes.fromhex("cd" * 32)
        finalizer.consumption_oracle.functions.getClaimKey.return_value.call.return_value = claim_key_bytes
        finalizer.consumption_oracle.functions.isFinalized.return_value.call.return_value = False
        
        mock_bucket = (1700000100, 1, 3, False, False, 5000, 6000,
                       bytes.fromhex("ef" * 32), bytes.fromhex("12" * 32), 7, 5)
        finalizer.consumption_oracle.functions.getClaimBucket.return_value.call.return_value = mock_bucket
        
        tx_hash = bytes.fromhex("aa" * 32)
        finalizer.web3.eth.send_raw_transaction.return_value = tx_hash
        finalizer.web3.eth.wait_for_transaction_receipt.return_value = {
            'status': 1,
            'gasUsed': 150000,
            'blockNumber': 12345
        }
        
        # After finalization, bucket shows disputed
        mock_bucket_after = (1700000100, 1, 3, False, True, 0, 6000,
                             bytes.fromhex("00" * 32), bytes.fromhex("00" * 32), 7, 0)
        finalizer.consumption_oracle.functions.getClaimBucket.return_value.call.side_effect = [
            mock_bucket, mock_bucket_after
        ]
        
        result = finalizer.finalize_consumption(consumer_id, hour_id)
        
        assert result.success is True
        assert result.disputed is True


class TestFinalizerService:
    """Tests for FinalizerService."""
    
    @pytest.fixture
    def mock_web3(self):
        """Create a mock Web3 instance."""
        web3 = MagicMock()
        web3.eth.chain_id = 31337
        web3.eth.gas_price = 1000000000
        web3.eth.get_transaction_count.return_value = 0
        web3.eth.get_block.return_value = {'timestamp': 1700000200}
        return web3
    
    @pytest.fixture
    def finalizer(self, mock_web3):
        """Create a ClaimFinalizer with mocks."""
        account = Account.create()
        return ClaimFinalizer(
            web3=mock_web3,
            finalizer_private_key=account.key.hex(),
            production_oracle_address="0x1111111111111111111111111111111111111111",
            consumption_oracle_address="0x2222222222222222222222222222222222222222"
        )
    
    @pytest.fixture
    def service(self, finalizer):
        """Create a FinalizerService."""
        return FinalizerService(finalizer=finalizer, poll_interval=1)
    
    def test_service_initialization(self, service):
        """Test service initializes correctly."""
        assert service.poll_interval == 1
        assert service.get_pending_count() == (0, 0)
    
    def test_add_pending_production(self, service, finalizer):
        """Test adding a pending production claim."""
        producer_id = "0x" + "ab" * 32
        hour_id = 500000
        
        claim_key_bytes = bytes.fromhex("cd" * 32)
        finalizer.production_oracle.functions.getClaimKey.return_value.call.return_value = claim_key_bytes
        
        mock_bucket = (1700000300, 1, 3, False, False, 5000, 6000,
                       bytes.fromhex("ef" * 32), bytes.fromhex("12" * 32), 7, 5)
        finalizer.production_oracle.functions.getClaimBucket.return_value.call.return_value = mock_bucket
        
        claim = service.add_pending_production(producer_id, hour_id)
        
        assert claim is not None
        assert claim.subject_id == producer_id
        assert claim.hour_id == hour_id
        assert claim.claim_type == ClaimType.PRODUCTION
        assert service.get_pending_count() == (1, 0)
    
    def test_add_pending_consumption(self, service, finalizer):
        """Test adding a pending consumption claim."""
        consumer_id = "0x" + "ab" * 32
        hour_id = 500000
        
        claim_key_bytes = bytes.fromhex("cd" * 32)
        finalizer.consumption_oracle.functions.getClaimKey.return_value.call.return_value = claim_key_bytes
        
        mock_bucket = (1700000300, 1, 3, False, False, 5000, 6000,
                       bytes.fromhex("ef" * 32), bytes.fromhex("12" * 32), 7, 5)
        finalizer.consumption_oracle.functions.getClaimBucket.return_value.call.return_value = mock_bucket
        
        claim = service.add_pending_consumption(consumer_id, hour_id)
        
        assert claim is not None
        assert claim.claim_type == ClaimType.CONSUMPTION
        assert service.get_pending_count() == (0, 1)
    
    def test_add_pending_already_finalized(self, service, finalizer):
        """Test adding a claim that's already finalized returns None."""
        producer_id = "0x" + "ab" * 32
        hour_id = 500000
        
        claim_key_bytes = bytes.fromhex("cd" * 32)
        finalizer.production_oracle.functions.getClaimKey.return_value.call.return_value = claim_key_bytes
        
        # Bucket shows finalized
        mock_bucket = (1700000100, 1, 3, True, False, 5000, 6000,
                       bytes.fromhex("ef" * 32), bytes.fromhex("12" * 32), 7, 5)
        finalizer.production_oracle.functions.getClaimBucket.return_value.call.return_value = mock_bucket
        
        claim = service.add_pending_production(producer_id, hour_id)
        
        assert claim is None
        assert service.get_pending_count() == (0, 0)
    
    def test_check_and_finalize_expired(self, service, finalizer):
        """Test checking and finalizing expired claims."""
        producer_id = "0x" + "ab" * 32
        hour_id = 500000
        
        claim_key_bytes = bytes.fromhex("cd" * 32)
        finalizer.production_oracle.functions.getClaimKey.return_value.call.return_value = claim_key_bytes
        
        # First call: not finalized, deadline in past
        mock_bucket = (1700000100, 1, 3, False, False, 5000, 6000,
                       bytes.fromhex("ef" * 32), bytes.fromhex("12" * 32), 7, 5)
        finalizer.production_oracle.functions.getClaimBucket.return_value.call.return_value = mock_bucket
        
        # Add the claim
        service.add_pending_production(producer_id, hour_id)
        
        # Mock finalization
        finalizer.production_oracle.functions.isFinalized.return_value.call.return_value = False
        
        tx_hash = bytes.fromhex("aa" * 32)
        finalizer.web3.eth.send_raw_transaction.return_value = tx_hash
        finalizer.web3.eth.wait_for_transaction_receipt.return_value = {
            'status': 1,
            'gasUsed': 150000,
            'blockNumber': 12345
        }
        
        mock_bucket_after = (1700000100, 1, 3, True, False, 5000, 6000,
                             bytes.fromhex("ef" * 32), bytes.fromhex("12" * 32), 7, 5)
        finalizer.production_oracle.functions.getClaimBucket.return_value.call.side_effect = [
            mock_bucket, mock_bucket_after
        ]
        
        results = service.check_and_finalize_expired()
        
        assert len(results) == 1
        assert results[0].success is True
        assert service.get_pending_count() == (0, 0)
    
    def test_run_once(self, service, finalizer):
        """Test running a single finalization cycle."""
        # No pending claims
        results = service.run_once()
        assert len(results) == 0
    
    def test_get_results(self, service):
        """Test getting finalization results."""
        results = service.get_results()
        assert isinstance(results, list)
        assert len(results) == 0
    
    def test_clear_results(self, service):
        """Test clearing results."""
        service.clear_results()
        assert len(service.get_results()) == 0


class TestFinalizationResult:
    """Tests for FinalizationResult dataclass."""
    
    def test_successful_result(self):
        """Test creating a successful result."""
        result = FinalizationResult(
            success=True,
            claim_key="0x" + "ab" * 32,
            tx_hash="0x" + "cd" * 32,
            gas_used=150000,
            block_number=12345
        )
        
        assert result.success is True
        assert result.tx_hash is not None
        assert result.error is None
        assert result.already_finalized is False
    
    def test_already_finalized_result(self):
        """Test creating an already finalized result."""
        result = FinalizationResult(
            success=True,
            claim_key="0x" + "ab" * 32,
            already_finalized=True
        )
        
        assert result.success is True
        assert result.already_finalized is True
        assert result.tx_hash is None
    
    def test_failed_result(self):
        """Test creating a failed result."""
        result = FinalizationResult(
            success=False,
            claim_key="0x" + "ab" * 32,
            error="Deadline not reached"
        )
        
        assert result.success is False
        assert result.error == "Deadline not reached"
    
    def test_disputed_result(self):
        """Test creating a disputed result."""
        result = FinalizationResult(
            success=True,
            claim_key="0x" + "ab" * 32,
            tx_hash="0x" + "cd" * 32,
            disputed=True
        )
        
        assert result.success is True
        assert result.disputed is True


class TestPendingClaim:
    """Tests for PendingClaim dataclass."""
    
    def test_pending_claim_creation(self):
        """Test creating a pending claim."""
        claim = PendingClaim(
            claim_key="0x" + "ab" * 32,
            subject_id="0x" + "cd" * 32,
            hour_id=500000,
            claim_type=ClaimType.PRODUCTION,
            deadline=1700000100,
            snapshot_id=1,
            finalized=False,
            disputed=False
        )
        
        assert claim.claim_key == "0x" + "ab" * 32
        assert claim.hour_id == 500000
        assert claim.claim_type == ClaimType.PRODUCTION
        assert claim.finalized is False


class TestCreateFromEnv:
    """Tests for environment-based factory functions."""
    
    def test_create_finalizer_missing_private_key(self):
        """Test error when private key is missing."""
        mock_web3 = MagicMock()
        
        with patch.dict(os.environ, {}, clear=True):
            with pytest.raises(ValueError, match="FINALIZER_PRIVATE_KEY"):
                create_finalizer_from_env(mock_web3)
    
    def test_create_finalizer_missing_production_oracle(self):
        """Test error when production oracle address is missing."""
        mock_web3 = MagicMock()
        account = Account.create()
        
        with patch.dict(os.environ, {
            "FINALIZER_PRIVATE_KEY": account.key.hex()
        }, clear=True):
            with pytest.raises(ValueError, match="PRODUCTION_ORACLE_ADDRESS"):
                create_finalizer_from_env(mock_web3)
    
    def test_create_finalizer_missing_consumption_oracle(self):
        """Test error when consumption oracle address is missing."""
        mock_web3 = MagicMock()
        account = Account.create()
        
        with patch.dict(os.environ, {
            "FINALIZER_PRIVATE_KEY": account.key.hex(),
            "PRODUCTION_ORACLE_ADDRESS": "0x1111111111111111111111111111111111111111"
        }, clear=True):
            with pytest.raises(ValueError, match="CONSUMPTION_ORACLE_ADDRESS"):
                create_finalizer_from_env(mock_web3)
    
    def test_create_finalizer_success(self):
        """Test successful creation from environment."""
        mock_web3 = MagicMock()
        mock_web3.eth.chain_id = 31337
        account = Account.create()
        
        with patch.dict(os.environ, {
            "FINALIZER_PRIVATE_KEY": account.key.hex(),
            "PRODUCTION_ORACLE_ADDRESS": "0x1111111111111111111111111111111111111111",
            "CONSUMPTION_ORACLE_ADDRESS": "0x2222222222222222222222222222222222222222"
        }, clear=True):
            finalizer = create_finalizer_from_env(mock_web3)
            
            assert finalizer is not None
            # Verify the address is set (it's derived from the private key internally)
            assert finalizer.address is not None
            assert finalizer.address.startswith('0x')
    
    def test_create_service_success(self):
        """Test successful service creation from environment."""
        mock_web3 = MagicMock()
        mock_web3.eth.chain_id = 31337
        account = Account.create()
        
        with patch.dict(os.environ, {
            "FINALIZER_PRIVATE_KEY": account.key.hex(),
            "PRODUCTION_ORACLE_ADDRESS": "0x1111111111111111111111111111111111111111",
            "CONSUMPTION_ORACLE_ADDRESS": "0x2222222222222222222222222222222222222222",
            "FINALIZER_POLL_INTERVAL": "5"
        }, clear=True):
            service = create_service_from_env(mock_web3)
            
            assert service is not None
            assert service.poll_interval == 5


if __name__ == "__main__":
    pytest.main([__file__, "-v"])
