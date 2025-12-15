"""
Tests for Evidence Store.

Requirements: 9.5
"""

import pytest
from datetime import datetime, timezone

import sys
import os
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.dirname(__file__))))

from oracle.evidence_store import (
    InMemoryEvidenceStore,
    Evidence,
    ClaimSubmission,
)


class TestInMemoryEvidenceStore:
    """Tests for InMemoryEvidenceStore."""
    
    @pytest.fixture
    def store(self):
        """Create a fresh in-memory store for each test."""
        return InMemoryEvidenceStore()
    
    def test_insert_evidence(self, store):
        """Test inserting evidence."""
        evidence = Evidence(
            id=None,
            evidence_root="0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef",
            verifier_address="0x1234567890123456789012345678901234567890",
            system_id="system_123",
            hour_id=500000,
            raw_response={"test": "data"},
            canonical_json='{"test":"data"}',
            canonical_hash="0xabcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890",
            signature="0x" + "ab" * 65
        )
        
        evidence_id = store.insert_evidence(evidence)
        
        assert evidence_id == 1
        assert evidence.id == 1
        assert evidence.created_at is not None
    
    def test_insert_duplicate_evidence_root_fails(self, store):
        """Test that duplicate evidence roots are rejected."""
        evidence1 = Evidence(
            id=None,
            evidence_root="0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef",
            verifier_address="0x1234567890123456789012345678901234567890",
            system_id="system_123",
            hour_id=500000,
            raw_response={"test": "data"},
            canonical_json='{"test":"data"}',
            canonical_hash="0xabcdef",
            signature="0xsig"
        )
        
        evidence2 = Evidence(
            id=None,
            evidence_root="0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef",  # Same root
            verifier_address="0x2222222222222222222222222222222222222222",
            system_id="system_456",
            hour_id=500001,
            raw_response={"test": "other"},
            canonical_json='{"test":"other"}',
            canonical_hash="0xfedcba",
            signature="0xsig2"
        )
        
        store.insert_evidence(evidence1)
        
        with pytest.raises(ValueError, match="already exists"):
            store.insert_evidence(evidence2)
    
    def test_get_evidence_by_root(self, store):
        """Test retrieving evidence by root."""
        evidence = Evidence(
            id=None,
            evidence_root="0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef",
            verifier_address="0x1234567890123456789012345678901234567890",
            system_id="system_123",
            hour_id=500000,
            raw_response={"test": "data"},
            canonical_json='{"test":"data"}',
            canonical_hash="0xabcdef",
            signature="0xsig"
        )
        
        store.insert_evidence(evidence)
        
        retrieved = store.get_evidence_by_root(evidence.evidence_root)
        
        assert retrieved is not None
        assert retrieved.system_id == "system_123"
        assert retrieved.hour_id == 500000
    
    def test_get_evidence_by_root_not_found(self, store):
        """Test retrieving non-existent evidence."""
        result = store.get_evidence_by_root("0xnonexistent")
        assert result is None
    
    def test_get_evidence_by_hour(self, store):
        """Test retrieving evidence by hour."""
        # Insert multiple evidence records
        for i in range(3):
            evidence = Evidence(
                id=None,
                evidence_root=f"0x{i:064x}",
                verifier_address="0x1234567890123456789012345678901234567890",
                system_id=f"system_{i}",
                hour_id=500000,
                raw_response={"index": i},
                canonical_json=f'{{"index":{i}}}',
                canonical_hash=f"0x{i:064x}",
                signature="0xsig"
            )
            store.insert_evidence(evidence)
        
        # Insert one for different hour
        evidence = Evidence(
            id=None,
            evidence_root="0x" + "ff" * 32,
            verifier_address="0x1234567890123456789012345678901234567890",
            system_id="system_other",
            hour_id=500001,
            raw_response={"other": True},
            canonical_json='{"other":true}',
            canonical_hash="0xother",
            signature="0xsig"
        )
        store.insert_evidence(evidence)
        
        results = store.get_evidence_by_hour(500000)
        
        assert len(results) == 3
        assert all(e.hour_id == 500000 for e in results)
    
    def test_get_evidence_by_hour_with_verifier_filter(self, store):
        """Test filtering evidence by verifier."""
        verifier1 = "0x1111111111111111111111111111111111111111"
        verifier2 = "0x2222222222222222222222222222222222222222"
        
        for i, verifier in enumerate([verifier1, verifier1, verifier2]):
            evidence = Evidence(
                id=None,
                evidence_root=f"0x{i:064x}",
                verifier_address=verifier,
                system_id=f"system_{i}",
                hour_id=500000,
                raw_response={"index": i},
                canonical_json=f'{{"index":{i}}}',
                canonical_hash=f"0x{i:064x}",
                signature="0xsig"
            )
            store.insert_evidence(evidence)
        
        results = store.get_evidence_by_hour(500000, verifier1)
        
        assert len(results) == 2
        assert all(e.verifier_address.lower() == verifier1.lower() for e in results)
    
    def test_get_evidence_by_system(self, store):
        """Test retrieving evidence by system."""
        for hour in range(500000, 500005):
            evidence = Evidence(
                id=None,
                evidence_root=f"0x{hour:064x}",
                verifier_address="0x1234567890123456789012345678901234567890",
                system_id="system_123",
                hour_id=hour,
                raw_response={"hour": hour},
                canonical_json=f'{{"hour":{hour}}}',
                canonical_hash=f"0x{hour:064x}",
                signature="0xsig"
            )
            store.insert_evidence(evidence)
        
        results = store.get_evidence_by_system("system_123")
        
        assert len(results) == 5
    
    def test_get_evidence_by_system_with_hour_range(self, store):
        """Test filtering evidence by hour range."""
        for hour in range(500000, 500010):
            evidence = Evidence(
                id=None,
                evidence_root=f"0x{hour:064x}",
                verifier_address="0x1234567890123456789012345678901234567890",
                system_id="system_123",
                hour_id=hour,
                raw_response={"hour": hour},
                canonical_json=f'{{"hour":{hour}}}',
                canonical_hash=f"0x{hour:064x}",
                signature="0xsig"
            )
            store.insert_evidence(evidence)
        
        results = store.get_evidence_by_system("system_123", start_hour=500003, end_hour=500007)
        
        assert len(results) == 5
        assert all(500003 <= e.hour_id <= 500007 for e in results)
    
    def test_evidence_exists(self, store):
        """Test checking if evidence exists."""
        evidence = Evidence(
            id=None,
            evidence_root="0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef",
            verifier_address="0x1234567890123456789012345678901234567890",
            system_id="system_123",
            hour_id=500000,
            raw_response={"test": "data"},
            canonical_json='{"test":"data"}',
            canonical_hash="0xabcdef",
            signature="0xsig"
        )
        
        store.insert_evidence(evidence)
        
        assert store.evidence_exists(
            "0x1234567890123456789012345678901234567890",
            "system_123",
            500000
        )
        assert not store.evidence_exists(
            "0x1234567890123456789012345678901234567890",
            "system_123",
            500001
        )


class TestClaimSubmissions:
    """Tests for claim submission operations."""
    
    @pytest.fixture
    def store(self):
        """Create a fresh in-memory store for each test."""
        return InMemoryEvidenceStore()
    
    def test_insert_claim_submission(self, store):
        """Test inserting a claim submission."""
        submission = ClaimSubmission(
            id=None,
            claim_key="0x" + "ab" * 32,
            verifier_address="0x1234567890123456789012345678901234567890",
            energy_wh=5000,
            evidence_root="0x" + "cd" * 32,
            tx_hash=None,
            status="pending"
        )
        
        submission_id = store.insert_claim_submission(submission)
        
        assert submission_id == 1
        assert submission.id == 1
        assert submission.created_at is not None
    
    def test_update_submission_status(self, store):
        """Test updating submission status."""
        submission = ClaimSubmission(
            id=None,
            claim_key="0x" + "ab" * 32,
            verifier_address="0x1234567890123456789012345678901234567890",
            energy_wh=5000,
            evidence_root="0x" + "cd" * 32,
            status="pending"
        )
        
        submission_id = store.insert_claim_submission(submission)
        
        store.update_submission_status(submission_id, "confirmed", "0x" + "ef" * 32)
        
        updated = store.get_submission_by_id(submission_id)
        assert updated.status == "confirmed"
        assert updated.tx_hash == "0x" + "ef" * 32
    
    def test_get_submissions_by_claim(self, store):
        """Test retrieving submissions by claim key."""
        claim_key = "0x" + "ab" * 32
        
        for i in range(3):
            submission = ClaimSubmission(
                id=None,
                claim_key=claim_key,
                verifier_address=f"0x{i:040x}",
                energy_wh=5000 + i,
                evidence_root=f"0x{i:064x}",
                status="pending"
            )
            store.insert_claim_submission(submission)
        
        results = store.get_submissions_by_claim(claim_key)
        
        assert len(results) == 3
        assert all(s.claim_key == claim_key for s in results)
    
    def test_get_pending_submissions(self, store):
        """Test retrieving pending submissions."""
        for i, status in enumerate(["pending", "confirmed", "pending", "failed"]):
            submission = ClaimSubmission(
                id=None,
                claim_key=f"0x{i:064x}",
                verifier_address="0x1234567890123456789012345678901234567890",
                energy_wh=5000,
                evidence_root=f"0x{i:064x}",
                status=status
            )
            store.insert_claim_submission(submission)
        
        pending = store.get_pending_submissions()
        
        assert len(pending) == 2
        assert all(s.status == "pending" for s in pending)
    
    def test_submission_exists(self, store):
        """Test checking if submission exists."""
        submission = ClaimSubmission(
            id=None,
            claim_key="0x" + "ab" * 32,
            verifier_address="0x1234567890123456789012345678901234567890",
            energy_wh=5000,
            evidence_root="0x" + "cd" * 32,
            status="pending"
        )
        
        store.insert_claim_submission(submission)
        
        assert store.submission_exists(
            "0x" + "ab" * 32,
            "0x1234567890123456789012345678901234567890"
        )
        assert not store.submission_exists(
            "0x" + "ab" * 32,
            "0x9999999999999999999999999999999999999999"
        )


if __name__ == "__main__":
    pytest.main([__file__, "-v"])
