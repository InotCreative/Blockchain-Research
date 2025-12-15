"""
Tests for Consumption Client.

Requirements: 10.1, 10.2, 10.3, 10.4
"""

import pytest
import tempfile
import os
from datetime import datetime, timezone

import sys
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.dirname(__file__))))

from oracle.consumption_client import (
    ConsumptionClient,
    MockConsumptionClient,
    CSVConsumptionParser,
    ConsumptionRecord,
    HourlyConsumption,
    aggregate_hourly,
)


class TestCSVConsumptionParser:
    """Tests for CSV parsing."""
    
    @pytest.fixture
    def sample_csv(self):
        """Create a sample CSV file."""
        content = """consumer_id,timestamp,energy_wh
meter_001,2024-01-15T10:00:00Z,5000
meter_001,2024-01-15T11:00:00Z,5500
meter_002,2024-01-15T10:00:00Z,3000
"""
        with tempfile.NamedTemporaryFile(mode='w', suffix='.csv', delete=False) as f:
            f.write(content)
            return f.name
    
    @pytest.fixture
    def kwh_csv(self):
        """Create a CSV file with kWh values."""
        content = """meter_id,datetime,energy_kwh
meter_001,2024-01-15T10:00:00Z,5.0
meter_001,2024-01-15T11:00:00Z,5.5
"""
        with tempfile.NamedTemporaryFile(mode='w', suffix='.csv', delete=False) as f:
            f.write(content)
            return f.name
    
    @pytest.fixture
    def unix_timestamp_csv(self):
        """Create a CSV file with Unix timestamps."""
        content = """consumer_id,timestamp,energy_wh
meter_001,1705312800,5000
meter_001,1705316400,5500
"""
        with tempfile.NamedTemporaryFile(mode='w', suffix='.csv', delete=False) as f:
            f.write(content)
            return f.name
    
    def test_parse_basic_csv(self, sample_csv):
        """Test parsing basic CSV file."""
        parser = CSVConsumptionParser(sample_csv)
        records = parser.parse_all()
        
        assert len(records) == 3
        assert records[0].consumer_id == "meter_001"
        assert records[0].energy_wh == 5000
        os.unlink(sample_csv)
    
    def test_parse_kwh_conversion(self, kwh_csv):
        """Test kWh to Wh conversion."""
        parser = CSVConsumptionParser(kwh_csv)
        records = parser.parse_all()
        
        assert len(records) == 2
        assert records[0].energy_wh == 5000  # 5.0 kWh * 1000
        assert records[1].energy_wh == 5500  # 5.5 kWh * 1000
        os.unlink(kwh_csv)
    
    def test_parse_unix_timestamp(self, unix_timestamp_csv):
        """Test parsing Unix timestamps."""
        parser = CSVConsumptionParser(unix_timestamp_csv)
        records = parser.parse_all()
        
        assert len(records) == 2
        # Verify hour_id calculation
        expected_hour_id = 1705312800 // 3600
        assert records[0].hour_id == expected_hour_id
        os.unlink(unix_timestamp_csv)
    
    def test_parse_alternative_column_names(self):
        """Test parsing with alternative column names."""
        content = """meter_id,time,wh
meter_001,2024-01-15T10:00:00Z,5000
"""
        with tempfile.NamedTemporaryFile(mode='w', suffix='.csv', delete=False) as f:
            f.write(content)
            csv_path = f.name
        
        parser = CSVConsumptionParser(csv_path)
        records = parser.parse_all()
        
        assert len(records) == 1
        assert records[0].consumer_id == "meter_001"
        assert records[0].energy_wh == 5000
        os.unlink(csv_path)
    
    def test_parse_missing_columns_raises(self):
        """Test that missing required columns raise error."""
        content = """id,value
meter_001,5000
"""
        with tempfile.NamedTemporaryFile(mode='w', suffix='.csv', delete=False) as f:
            f.write(content)
            csv_path = f.name
        
        parser = CSVConsumptionParser(csv_path)
        
        with pytest.raises(ValueError, match="Missing required columns"):
            parser.parse_all()
        
        os.unlink(csv_path)
    
    def test_parse_skips_invalid_rows(self):
        """Test that invalid rows are skipped."""
        content = """consumer_id,timestamp,energy_wh
meter_001,2024-01-15T10:00:00Z,5000
meter_002,invalid_timestamp,3000
meter_003,2024-01-15T11:00:00Z,4000
"""
        with tempfile.NamedTemporaryFile(mode='w', suffix='.csv', delete=False) as f:
            f.write(content)
            csv_path = f.name
        
        parser = CSVConsumptionParser(csv_path)
        records = parser.parse_all()
        
        # Should skip the invalid row
        assert len(records) == 2
        assert records[0].consumer_id == "meter_001"
        assert records[1].consumer_id == "meter_003"
        os.unlink(csv_path)
    
    def test_hour_id_calculation(self, sample_csv):
        """Test hour_id is calculated correctly."""
        parser = CSVConsumptionParser(sample_csv)
        records = parser.parse_all()
        
        # 2024-01-15T10:00:00Z = 1705312800 Unix timestamp
        # hour_id = 1705312800 // 3600 = 473698
        expected_hour_id = 1705312800 // 3600
        assert records[0].hour_id == expected_hour_id
        os.unlink(sample_csv)


class TestConsumptionClient:
    """Tests for ConsumptionClient."""
    
    @pytest.fixture
    def client(self):
        """Create a consumption client."""
        return ConsumptionClient(
            verifier_address="0x1234567890123456789012345678901234567890"
        )
    
    def test_process_record(self, client):
        """Test processing a consumption record."""
        record = ConsumptionRecord(
            consumer_id="meter_001",
            hour_id=500000,
            energy_wh=5000,
            timestamp=datetime(2024, 1, 15, 10, 0, 0, tzinfo=timezone.utc),
            raw_data={"consumer_id": "meter_001", "energy_wh": 5000}
        )
        
        result = client.process_record(record)
        
        assert isinstance(result, HourlyConsumption)
        assert result.consumer_id == "meter_001"
        assert result.hour_id == 500000
        assert result.energy_wh == 5000
        assert result.consumer_id_hash.startswith('0x')
        assert result.canonical_hash.startswith('0x')
        assert result.evidence_root.startswith('0x')
    
    def test_consumer_id_hash_deterministic(self, client):
        """Test consumer ID hash is deterministic."""
        hash1 = client._compute_consumer_id_hash("meter_001")
        hash2 = client._compute_consumer_id_hash("meter_001")
        
        assert hash1 == hash2
    
    def test_consumer_id_hash_different_ids(self, client):
        """Test different consumer IDs produce different hashes."""
        hash1 = client._compute_consumer_id_hash("meter_001")
        hash2 = client._compute_consumer_id_hash("meter_002")
        
        assert hash1 != hash2
    
    def test_evidence_root_format(self, client):
        """Test evidence root has correct format."""
        record = ConsumptionRecord(
            consumer_id="meter_001",
            hour_id=500000,
            energy_wh=5000,
            timestamp=datetime.now(timezone.utc),
            raw_data={"test": "data"}
        )
        
        result = client.process_record(record)
        
        assert result.evidence_root.startswith('0x')
        assert len(result.evidence_root) == 66
    
    def test_evidence_root_deterministic(self, client):
        """Test evidence root is deterministic."""
        record = ConsumptionRecord(
            consumer_id="meter_001",
            hour_id=500000,
            energy_wh=5000,
            timestamp=datetime.now(timezone.utc),
            raw_data={"test": "data"}
        )
        
        result1 = client.process_record(record)
        result2 = client.process_record(record)
        
        assert result1.evidence_root == result2.evidence_root
    
    def test_evidence_root_different_verifiers(self):
        """Test different verifiers produce different evidence roots."""
        client1 = ConsumptionClient("0x1111111111111111111111111111111111111111")
        client2 = ConsumptionClient("0x2222222222222222222222222222222222222222")
        
        record = ConsumptionRecord(
            consumer_id="meter_001",
            hour_id=500000,
            energy_wh=5000,
            timestamp=datetime.now(timezone.utc),
            raw_data={"test": "data"}
        )
        
        result1 = client1.process_record(record)
        result2 = client2.process_record(record)
        
        assert result1.evidence_root != result2.evidence_root
    
    def test_process_csv(self):
        """Test processing a CSV file."""
        content = """consumer_id,timestamp,energy_wh
meter_001,2024-01-15T10:00:00Z,5000
meter_001,2024-01-15T11:00:00Z,5500
"""
        with tempfile.NamedTemporaryFile(mode='w', suffix='.csv', delete=False) as f:
            f.write(content)
            csv_path = f.name
        
        client = ConsumptionClient("0x1234567890123456789012345678901234567890")
        results = client.process_csv(csv_path)
        
        assert len(results) == 2
        assert all(isinstance(r, HourlyConsumption) for r in results)
        os.unlink(csv_path)


class TestMockConsumptionClient:
    """Tests for MockConsumptionClient."""
    
    def test_mock_submit(self):
        """Test mock submission."""
        client = MockConsumptionClient("0x1234567890123456789012345678901234567890")
        
        consumption = HourlyConsumption(
            consumer_id="meter_001",
            consumer_id_hash="0x" + "ab" * 32,
            hour_id=500000,
            energy_wh=5000,
            raw_data={"test": "data"},
            canonical_json='{"test":"data"}',
            canonical_hash="0x" + "cd" * 32,
            evidence_root="0x" + "ef" * 32
        )
        
        tx_hash = client.submit_consumption(consumption, "0x" + "11" * 32)
        
        assert tx_hash is not None
        assert tx_hash.startswith('0x')
        assert len(client.submitted_claims) == 1
    
    def test_mock_tracks_submissions(self):
        """Test that mock tracks all submissions."""
        client = MockConsumptionClient("0x1234567890123456789012345678901234567890")
        
        for i in range(3):
            consumption = HourlyConsumption(
                consumer_id=f"meter_{i:03d}",
                consumer_id_hash=f"0x{i:064x}",
                hour_id=500000 + i,
                energy_wh=5000 + i * 100,
                raw_data={"index": i},
                canonical_json=f'{{"index":{i}}}',
                canonical_hash=f"0x{i:064x}",
                evidence_root=f"0x{i:064x}"
            )
            client.submit_consumption(consumption, f"0x{i:064x}")
        
        assert len(client.submitted_claims) == 3


class TestAggregateHourly:
    """Tests for hourly aggregation function."""
    
    def test_aggregate_single_consumer(self):
        """Test aggregating records for a single consumer."""
        records = [
            ConsumptionRecord("meter_001", 500000, 1000, datetime.now(timezone.utc), {}),
            ConsumptionRecord("meter_001", 500000, 2000, datetime.now(timezone.utc), {}),
            ConsumptionRecord("meter_001", 500000, 3000, datetime.now(timezone.utc), {}),
        ]
        
        result = aggregate_hourly(records)
        
        assert result[("meter_001", 500000)] == 6000
    
    def test_aggregate_multiple_consumers(self):
        """Test aggregating records for multiple consumers."""
        records = [
            ConsumptionRecord("meter_001", 500000, 1000, datetime.now(timezone.utc), {}),
            ConsumptionRecord("meter_002", 500000, 2000, datetime.now(timezone.utc), {}),
            ConsumptionRecord("meter_001", 500000, 1500, datetime.now(timezone.utc), {}),
        ]
        
        result = aggregate_hourly(records)
        
        assert result[("meter_001", 500000)] == 2500
        assert result[("meter_002", 500000)] == 2000
    
    def test_aggregate_multiple_hours(self):
        """Test aggregating records across multiple hours."""
        records = [
            ConsumptionRecord("meter_001", 500000, 1000, datetime.now(timezone.utc), {}),
            ConsumptionRecord("meter_001", 500001, 2000, datetime.now(timezone.utc), {}),
            ConsumptionRecord("meter_001", 500000, 1500, datetime.now(timezone.utc), {}),
        ]
        
        result = aggregate_hourly(records)
        
        assert result[("meter_001", 500000)] == 2500
        assert result[("meter_001", 500001)] == 2000


if __name__ == "__main__":
    pytest.main([__file__, "-v"])
