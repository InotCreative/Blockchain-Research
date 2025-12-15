"""
Tests for Enphase Client.

Requirements: 9.1, 9.2, 9.6, 9.7, 9.8
"""

import json
import time
import pytest
from unittest.mock import Mock, patch, MagicMock
from datetime import datetime, timezone

import sys
import os
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.dirname(__file__))))

from oracle.enphase_client import (
    EnphaseClient,
    MockEnphaseClient,
    HourlyProduction,
    RFC8785Canonicalizer,
    get_current_hour_id,
    get_previous_hour_id,
)


class TestRFC8785Canonicalizer:
    """Tests for RFC 8785 JSON canonicalization."""
    
    def test_canonicalize_simple_object(self):
        """Test canonicalization of simple object."""
        canonicalizer = RFC8785Canonicalizer()
        
        obj = {"b": 2, "a": 1}
        result = canonicalizer.canonicalize(obj)
        
        # Keys should be sorted
        assert result == '{"a":1,"b":2}'
    
    def test_canonicalize_nested_object(self):
        """Test canonicalization of nested object."""
        canonicalizer = RFC8785Canonicalizer()
        
        obj = {
            "z": {"b": 2, "a": 1},
            "a": [3, 1, 2]
        }
        result = canonicalizer.canonicalize(obj)
        
        # Keys sorted at all levels
        assert result == '{"a":[3,1,2],"z":{"a":1,"b":2}}'
    
    def test_canonicalize_no_whitespace(self):
        """Test that canonicalization removes whitespace."""
        canonicalizer = RFC8785Canonicalizer()
        
        obj = {"key": "value with spaces"}
        result = canonicalizer.canonicalize(obj)
        
        # No extra whitespace in structure
        assert ' ' not in result.replace("value with spaces", "")
    
    def test_compute_hash_deterministic(self):
        """Test that hash computation is deterministic."""
        canonicalizer = RFC8785Canonicalizer()
        
        json_str = '{"a":1,"b":2}'
        hash1 = canonicalizer.compute_hash(json_str)
        hash2 = canonicalizer.compute_hash(json_str)
        
        assert hash1 == hash2
        assert hash1.startswith('0x')
        assert len(hash1) == 66  # 0x + 64 hex chars
    
    def test_compute_hash_different_inputs(self):
        """Test that different inputs produce different hashes."""
        canonicalizer = RFC8785Canonicalizer()
        
        hash1 = canonicalizer.compute_hash('{"a":1}')
        hash2 = canonicalizer.compute_hash('{"a":2}')
        
        assert hash1 != hash2


class TestMockEnphaseClient:
    """Tests for MockEnphaseClient."""
    
    def test_get_hourly_production(self):
        """Test getting hourly production data."""
        verifier_address = "0x1234567890123456789012345678901234567890"
        client = MockEnphaseClient(verifier_address)
        
        system_id = "test_system_123"
        hour_id = 500000
        
        result = client.get_hourly_production(system_id, hour_id)
        
        assert isinstance(result, HourlyProduction)
        assert result.system_id == system_id
        assert result.hour_id == hour_id
        assert result.energy_wh >= 0
        assert result.canonical_json is not None
        assert result.canonical_hash.startswith('0x')
        assert result.evidence_root.startswith('0x')
    
    def test_get_hourly_production_with_mock_data(self):
        """Test with predefined mock data."""
        verifier_address = "0x1234567890123456789012345678901234567890"
        mock_data = {
            ("system_1", 500000): 5000,
            ("system_1", 500001): 6000,
        }
        client = MockEnphaseClient(verifier_address, mock_data)
        
        result = client.get_hourly_production("system_1", 500000)
        
        assert result.energy_wh == 5000
    
    def test_deterministic_mock_data(self):
        """Test that mock data is deterministic for same inputs."""
        verifier_address = "0x1234567890123456789012345678901234567890"
        client = MockEnphaseClient(verifier_address)
        
        result1 = client.get_hourly_production("system_1", 500000)
        result2 = client.get_hourly_production("system_1", 500000)
        
        assert result1.energy_wh == result2.energy_wh
        assert result1.evidence_root == result2.evidence_root
    
    def test_different_systems_different_data(self):
        """Test that different systems produce different data."""
        verifier_address = "0x1234567890123456789012345678901234567890"
        client = MockEnphaseClient(verifier_address)
        
        result1 = client.get_hourly_production("system_1", 500000)
        result2 = client.get_hourly_production("system_2", 500000)
        
        # Different systems should have different evidence roots
        assert result1.evidence_root != result2.evidence_root


class TestEnphaseClientRateLimiting:
    """Tests for rate limiting functionality."""
    
    def test_rate_limit_tracking(self):
        """Test that rate limit timestamps are tracked."""
        client = EnphaseClient(
            api_key="test_key",
            access_token="test_token",
            verifier_address="0x1234567890123456789012345678901234567890",
            rate_limit_requests=5,
            rate_limit_window=60
        )
        
        # Initially empty
        assert len(client._request_timestamps) == 0
    
    @patch('oracle.enphase_client.requests.Session')
    def test_rate_limit_wait(self, mock_session_class):
        """Test that rate limiting causes wait when limit reached."""
        mock_session = MagicMock()
        mock_response = MagicMock()
        mock_response.json.return_value = {"intervals": []}
        mock_response.raise_for_status = MagicMock()
        mock_session.get.return_value = mock_response
        mock_session_class.return_value = mock_session
        
        client = EnphaseClient(
            api_key="test_key",
            access_token="test_token",
            verifier_address="0x1234567890123456789012345678901234567890",
            rate_limit_requests=2,
            rate_limit_window=1  # 1 second window for fast test
        )
        
        # Fill up rate limit
        client._request_timestamps = [time.time(), time.time()]
        
        # This should wait
        start = time.time()
        client._wait_for_rate_limit()
        elapsed = time.time() - start
        
        # Should have waited approximately 1 second
        assert elapsed >= 0.5  # Allow some tolerance


class TestHourIdFunctions:
    """Tests for hour ID utility functions."""
    
    def test_get_current_hour_id(self):
        """Test getting current hour ID."""
        hour_id = get_current_hour_id()
        
        # Should be a reasonable value (after year 2020)
        assert hour_id > 438000  # Approx Jan 2020
        
        # Should match manual calculation
        expected = int(time.time()) // 3600
        assert abs(hour_id - expected) <= 1  # Allow 1 hour tolerance
    
    def test_get_previous_hour_id(self):
        """Test getting previous hour ID."""
        current = get_current_hour_id()
        previous = get_previous_hour_id()
        
        assert previous == current - 1


class TestSubHourlyAggregation:
    """Tests for sub-hourly data aggregation."""
    
    def test_aggregate_intervals(self):
        """Test aggregation of sub-hourly intervals."""
        verifier_address = "0x1234567890123456789012345678901234567890"
        client = MockEnphaseClient(verifier_address)
        
        # Create mock response with multiple intervals
        hour_id = 500000
        start_at = hour_id * 3600
        end_at = start_at + 3600
        
        response = {
            "intervals": [
                {"end_at": start_at + 900, "enwh": 100},   # 15 min
                {"end_at": start_at + 1800, "enwh": 150},  # 30 min
                {"end_at": start_at + 2700, "enwh": 200},  # 45 min
                {"end_at": start_at + 3600, "enwh": 250},  # 60 min
            ]
        }
        
        total = client._aggregate_to_hourly(response, start_at, end_at)
        
        assert total == 700  # 100 + 150 + 200 + 250
    
    def test_aggregate_excludes_outside_intervals(self):
        """Test that intervals outside the hour are excluded."""
        verifier_address = "0x1234567890123456789012345678901234567890"
        client = MockEnphaseClient(verifier_address)
        
        hour_id = 500000
        start_at = hour_id * 3600
        end_at = start_at + 3600
        
        response = {
            "intervals": [
                {"end_at": start_at - 100, "enwh": 1000},  # Before hour
                {"end_at": start_at + 1800, "enwh": 200},  # In hour
                {"end_at": end_at + 100, "enwh": 1000},    # After hour
            ]
        }
        
        total = client._aggregate_to_hourly(response, start_at, end_at)
        
        assert total == 200  # Only the interval within the hour


class TestEvidenceRootComputation:
    """Tests for evidence root computation."""
    
    def test_evidence_root_format(self):
        """Test evidence root has correct format."""
        verifier_address = "0x1234567890123456789012345678901234567890"
        client = MockEnphaseClient(verifier_address)
        
        result = client.get_hourly_production("system_1", 500000)
        
        assert result.evidence_root.startswith('0x')
        assert len(result.evidence_root) == 66
    
    def test_evidence_root_deterministic(self):
        """Test evidence root is deterministic."""
        verifier_address = "0x1234567890123456789012345678901234567890"
        client = MockEnphaseClient(verifier_address)
        
        result1 = client.get_hourly_production("system_1", 500000)
        result2 = client.get_hourly_production("system_1", 500000)
        
        assert result1.evidence_root == result2.evidence_root
    
    def test_evidence_root_different_verifiers(self):
        """Test different verifiers produce different evidence roots."""
        client1 = MockEnphaseClient("0x1111111111111111111111111111111111111111")
        client2 = MockEnphaseClient("0x2222222222222222222222222222222222222222")
        
        result1 = client1.get_hourly_production("system_1", 500000)
        result2 = client2.get_hourly_production("system_1", 500000)
        
        # Same system/hour but different verifiers = different evidence roots
        assert result1.evidence_root != result2.evidence_root


if __name__ == "__main__":
    pytest.main([__file__, "-v"])
