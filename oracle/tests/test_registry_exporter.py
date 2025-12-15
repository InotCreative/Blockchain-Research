"""
Tests for Registry Export Adapter.

Requirements: 11.1, 11.2, 11.3
"""

import pytest
import json
import csv
import os
import tempfile
from unittest.mock import Mock, MagicMock, patch
from datetime import datetime, timezone
from io import StringIO

import sys
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.dirname(__file__))))

from oracle.registry_exporter import (
    RegistryExporter,
    CertificateExport,
    CertificateIssuedEvent,
    create_exporter_from_env,
    create_exporter_from_addresses,
)
from oracle.evidence_store import InMemoryEvidenceStore, Evidence


class TestRegistryExporterInitialization:
    """Tests for RegistryExporter initialization."""
    
    @pytest.fixture
    def mock_web3(self):
        """Create a mock Web3 instance."""
        web3 = MagicMock()
        web3.eth.chain_id = 31337
        web3.eth.block_number = 100
        return web3
    
    @pytest.fixture
    def evidence_store(self):
        """Create an in-memory evidence store."""
        return InMemoryEvidenceStore()
    
    def test_exporter_initialization(self, mock_web3, evidence_store):
        """Test exporter initializes correctly."""
        exporter = RegistryExporter(
            web3=mock_web3,
            retirement_address="0x1111111111111111111111111111111111111111",
            registry_address="0x2222222222222222222222222222222222222222",
            production_oracle_address="0x3333333333333333333333333333333333333333",
            evidence_store=evidence_store
        )
        
        assert exporter.chain_id == 31337
        assert exporter.retirement is not None
        assert exporter.registry is not None
        assert exporter.production_oracle is not None
        assert exporter.evidence_store is evidence_store
    
    def test_exporter_with_checksum_addresses(self, mock_web3, evidence_store):
        """Test exporter handles checksum addresses."""
        exporter = RegistryExporter(
            web3=mock_web3,
            retirement_address="0xA513E6E4b8f2a923D98304ec87F64353C4D5C853",
            registry_address="0x9fE46736679d2D9a65F0992F2272dE9f3c7fa6e0",
            production_oracle_address="0xDc64a140Aa3E981100a9becA4E685f962f0cF6C9",
            evidence_store=evidence_store
        )
        
        assert exporter.retirement is not None


class TestEventListening:
    """Tests for CertificateIssued event listening."""
    
    @pytest.fixture
    def mock_web3(self):
        """Create a mock Web3 instance."""
        web3 = MagicMock()
        web3.eth.chain_id = 31337
        web3.eth.block_number = 100
        return web3
    
    @pytest.fixture
    def evidence_store(self):
        """Create an in-memory evidence store."""
        return InMemoryEvidenceStore()
    
    @pytest.fixture
    def exporter(self, mock_web3, evidence_store):
        """Create a RegistryExporter with mocks."""
        return RegistryExporter(
            web3=mock_web3,
            retirement_address="0x1111111111111111111111111111111111111111",
            registry_address="0x2222222222222222222222222222222222222222",
            production_oracle_address="0x3333333333333333333333333333333333333333",
            evidence_store=evidence_store
        )
    
    def test_get_certificate_events_empty(self, exporter):
        """Test getting events when none exist."""
        # Mock empty event filter
        mock_filter = MagicMock()
        mock_filter.get_all_entries.return_value = []
        exporter.retirement.events.CertificateIssued.create_filter.return_value = mock_filter
        
        events = exporter.get_certificate_events(0, 100)
        
        assert len(events) == 0
    
    def test_get_certificate_events_with_events(self, exporter):
        """Test getting events when they exist."""
        # Create mock event
        mock_event = {
            'args': {
                'certId': 1,
                'owner': '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266',
                'totalMwh': 2,
                'metadataHash': bytes.fromhex('ab' * 32),
                'claimKeys': [bytes.fromhex('cd' * 32), bytes.fromhex('ef' * 32)]
            },
            'transactionHash': bytes.fromhex('11' * 32),
            'blockNumber': 50,
            'logIndex': 0
        }
        
        mock_filter = MagicMock()
        mock_filter.get_all_entries.return_value = [mock_event]
        exporter.retirement.events.CertificateIssued.create_filter.return_value = mock_filter
        
        events = exporter.get_certificate_events(0, 100)
        
        assert len(events) == 1
        assert events[0].cert_id == 1
        assert events[0].owner == '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266'
        assert events[0].total_mwh == 2
        assert len(events[0].claim_keys) == 2
    
    def test_parse_certificate_event(self, exporter):
        """Test parsing a certificate event."""
        mock_event = {
            'args': {
                'certId': 5,
                'owner': '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266',
                'totalMwh': 3,
                'metadataHash': bytes.fromhex('ab' * 32),
                'claimKeys': [bytes.fromhex('cd' * 32)]
            },
            'transactionHash': bytes.fromhex('11' * 32),
            'blockNumber': 75,
            'logIndex': 2
        }
        
        parsed = exporter._parse_certificate_event(mock_event)
        
        assert parsed is not None
        assert parsed.cert_id == 5
        assert parsed.total_mwh == 3
        assert parsed.block_number == 75
        assert parsed.log_index == 2
        assert parsed.metadata_hash == '0x' + 'ab' * 32
    
    def test_listen_for_events_with_callback(self, exporter):
        """Test listening for events with callback."""
        callback_results = []
        
        def callback(event):
            callback_results.append(event)
        
        mock_event = {
            'args': {
                'certId': 1,
                'owner': '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266',
                'totalMwh': 1,
                'metadataHash': bytes.fromhex('ab' * 32),
                'claimKeys': []
            },
            'transactionHash': bytes.fromhex('11' * 32),
            'blockNumber': 50,
            'logIndex': 0
        }
        
        mock_filter = MagicMock()
        mock_filter.get_all_entries.return_value = [mock_event]
        exporter.retirement.events.CertificateIssued.create_filter.return_value = mock_filter
        
        events = exporter.listen_for_events(callback=callback, from_block=0)
        
        assert len(events) == 1
        assert len(callback_results) == 1
        assert callback_results[0].cert_id == 1
    
    def test_listen_for_events_updates_last_block(self, exporter):
        """Test that listening updates the last processed block."""
        mock_filter = MagicMock()
        mock_filter.get_all_entries.return_value = []
        exporter.retirement.events.CertificateIssued.create_filter.return_value = mock_filter
        
        exporter.listen_for_events(from_block=0)
        
        assert exporter._last_processed_block == 100  # mock_web3.eth.block_number


class TestCertificateDataRetrieval:
    """Tests for certificate data retrieval."""
    
    @pytest.fixture
    def mock_web3(self):
        """Create a mock Web3 instance."""
        web3 = MagicMock()
        web3.eth.chain_id = 31337
        web3.eth.block_number = 100
        return web3
    
    @pytest.fixture
    def evidence_store(self):
        """Create an in-memory evidence store."""
        return InMemoryEvidenceStore()
    
    @pytest.fixture
    def exporter(self, mock_web3, evidence_store):
        """Create a RegistryExporter with mocks."""
        return RegistryExporter(
            web3=mock_web3,
            retirement_address="0x1111111111111111111111111111111111111111",
            registry_address="0x2222222222222222222222222222222222222222",
            production_oracle_address="0x3333333333333333333333333333333333333333",
            evidence_store=evidence_store
        )
    
    def test_get_certificate_details(self, exporter):
        """Test getting certificate details from contract."""
        # Mock certificate tuple
        mock_cert = (
            '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266',  # owner
            [500000, 500001],  # hourIds
            [1000000, 500000],  # amounts
            [bytes.fromhex('ab' * 32), bytes.fromhex('cd' * 32)],  # evidenceRoots
            ['0x1111111111111111111111111111111111111111'],  # winningVerifiers
            [bytes.fromhex('ef' * 32), bytes.fromhex('12' * 32)],  # claimKeys
            1500000,  # totalWh
            bytes.fromhex('34' * 32),  # metadataHash
            1700000000  # timestamp
        )
        
        exporter.retirement.functions.getCertificate.return_value.call.return_value = mock_cert
        
        details = exporter.get_certificate_details(1)
        
        assert details is not None
        assert details['owner'] == '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266'
        assert len(details['hour_ids']) == 2
        assert details['total_wh'] == 1500000
        assert details['timestamp'] == 1700000000
    
    def test_get_certificate_details_not_found(self, exporter):
        """Test getting non-existent certificate."""
        exporter.retirement.functions.getCertificate.return_value.call.side_effect = Exception("Not found")
        
        details = exporter.get_certificate_details(999)
        
        assert details is None
    
    def test_get_claim_bucket(self, exporter):
        """Test getting claim bucket data."""
        mock_bucket = (
            1700000100,  # deadline
            1,  # snapshotId
            3,  # submissionCount
            True,  # finalized
            False,  # disputed
            5000,  # verifiedEnergyWh
            6000,  # maxSubmittedEnergyWh
            bytes.fromhex('ab' * 32),  # winningValueHash
            bytes.fromhex('cd' * 32),  # evidenceRoot
            7,  # allSubmittersBitmap
            5  # winningVerifierBitmap
        )
        
        exporter.production_oracle.functions.getClaimBucket.return_value.call.return_value = mock_bucket
        
        bucket = exporter.get_claim_bucket('0x' + 'ef' * 32)
        
        assert bucket is not None
        assert bucket['deadline'] == 1700000100
        assert bucket['snapshot_id'] == 1
        assert bucket['finalized'] is True
        assert bucket['winning_verifier_bitmap'] == 5
    
    def test_get_snapshot_verifiers(self, exporter):
        """Test getting snapshot verifiers."""
        mock_verifiers = [
            '0x1111111111111111111111111111111111111111',
            '0x2222222222222222222222222222222222222222',
            '0x3333333333333333333333333333333333333333'
        ]
        
        exporter.registry.functions.getSnapshotVerifiers.return_value.call.return_value = mock_verifiers
        
        verifiers = exporter.get_snapshot_verifiers(1)
        
        assert len(verifiers) == 3
        assert verifiers[0] == '0x1111111111111111111111111111111111111111'
    
    def test_get_winning_verifiers_from_bitmap(self, exporter):
        """Test resolving winning verifiers from bitmap."""
        mock_verifiers = [
            '0x1111111111111111111111111111111111111111',
            '0x2222222222222222222222222222222222222222',
            '0x3333333333333333333333333333333333333333'
        ]
        
        exporter.registry.functions.getSnapshotVerifiers.return_value.call.return_value = mock_verifiers
        
        # Bitmap 0b101 = verifiers at index 0 and 2
        winners = exporter.get_winning_verifiers_from_bitmap(1, 0b101)
        
        assert len(winners) == 2
        assert '0x1111111111111111111111111111111111111111' in winners
        assert '0x3333333333333333333333333333333333333333' in winners
        assert '0x2222222222222222222222222222222222222222' not in winners



class TestEvidenceRetrieval:
    """Tests for evidence retrieval from database."""
    
    @pytest.fixture
    def mock_web3(self):
        """Create a mock Web3 instance."""
        web3 = MagicMock()
        web3.eth.chain_id = 31337
        web3.eth.block_number = 100
        return web3
    
    @pytest.fixture
    def evidence_store(self):
        """Create an in-memory evidence store with test data."""
        store = InMemoryEvidenceStore()
        
        # Add test evidence
        store.insert_evidence(Evidence(
            id=None,
            evidence_root='0x' + 'ab' * 32,
            verifier_address='0x1111111111111111111111111111111111111111',
            system_id='system_1',
            hour_id=500000,
            raw_response={'energy': 5000},
            canonical_json='{"energy":5000}',
            canonical_hash='0x' + 'cd' * 32,
            signature='0x' + 'ef' * 65
        ))
        
        store.insert_evidence(Evidence(
            id=None,
            evidence_root='0x' + '12' * 32,
            verifier_address='0x2222222222222222222222222222222222222222',
            system_id='system_1',
            hour_id=500000,
            raw_response={'energy': 5000},
            canonical_json='{"energy":5000}',
            canonical_hash='0x' + '34' * 32,
            signature='0x' + '56' * 65
        ))
        
        return store
    
    @pytest.fixture
    def exporter(self, mock_web3, evidence_store):
        """Create a RegistryExporter with mocks."""
        return RegistryExporter(
            web3=mock_web3,
            retirement_address="0x1111111111111111111111111111111111111111",
            registry_address="0x2222222222222222222222222222222222222222",
            production_oracle_address="0x3333333333333333333333333333333333333333",
            evidence_store=evidence_store
        )
    
    def test_get_verifier_signatures(self, exporter):
        """Test retrieving verifier signatures."""
        signatures = exporter.get_verifier_signatures(
            hour_ids=[500000],
            evidence_roots=['0x' + 'ab' * 32]
        )
        
        assert len(signatures) >= 1
        assert signatures[0]['hour_id'] == 500000
        assert signatures[0]['verifier_address'] == '0x1111111111111111111111111111111111111111'
    
    def test_get_signatures_by_evidence_root(self, exporter):
        """Test getting signature by evidence root."""
        sig = exporter.get_signatures_by_evidence_root('0x' + 'ab' * 32)
        
        assert sig is not None
        assert sig['verifier_address'] == '0x1111111111111111111111111111111111111111'
        assert sig['system_id'] == 'system_1'
    
    def test_get_signatures_by_evidence_root_not_found(self, exporter):
        """Test getting non-existent signature."""
        sig = exporter.get_signatures_by_evidence_root('0x' + '99' * 32)
        
        assert sig is None


class TestExportBundleGeneration:
    """Tests for export bundle generation."""
    
    @pytest.fixture
    def mock_web3(self):
        """Create a mock Web3 instance."""
        web3 = MagicMock()
        web3.eth.chain_id = 31337
        web3.eth.block_number = 100
        return web3
    
    @pytest.fixture
    def evidence_store(self):
        """Create an in-memory evidence store."""
        return InMemoryEvidenceStore()
    
    @pytest.fixture
    def exporter(self, mock_web3, evidence_store):
        """Create a RegistryExporter with mocks."""
        return RegistryExporter(
            web3=mock_web3,
            retirement_address="0x1111111111111111111111111111111111111111",
            registry_address="0x2222222222222222222222222222222222222222",
            production_oracle_address="0x3333333333333333333333333333333333333333",
            evidence_store=evidence_store
        )
    
    @pytest.fixture
    def sample_export(self):
        """Create a sample certificate export."""
        return CertificateExport(
            cert_id=1,
            owner='0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266',
            hour_ids=[500000, 500001],
            amounts=[1000000, 500000],
            evidence_roots=['0x' + 'ab' * 32, '0x' + 'cd' * 32],
            winning_verifier_addresses=['0x1111111111111111111111111111111111111111'],
            claim_keys=['0x' + 'ef' * 32, '0x' + '12' * 32],
            total_wh=1500000,
            total_mwh=1,
            metadata_hash='0x' + '34' * 32,
            timestamp=1700000000,
            tx_hash='0x' + '56' * 32,
            block_number=50,
            chain_id=31337,
            verifier_signatures=[
                {
                    'hour_id': 500000,
                    'evidence_root': '0x' + 'ab' * 32,
                    'verifier_address': '0x1111111111111111111111111111111111111111',
                    'signature': '0x' + '78' * 65
                }
            ]
        )
    
    def test_export_certificate_json(self, exporter, sample_export):
        """Test exporting certificate as JSON."""
        json_str = exporter.export_certificate_json(sample_export)
        
        data = json.loads(json_str)
        
        assert data['cert_id'] == 1
        assert data['owner'] == '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266'
        assert data['total_wh'] == 1500000
        assert data['chain_id'] == 31337
        assert 'export_timestamp' in data
        assert 'export_version' in data
        assert len(data['verifier_signatures']) == 1
    
    def test_export_certificate_json_without_signatures(self, exporter, sample_export):
        """Test exporting certificate JSON without signatures."""
        json_str = exporter.export_certificate_json(sample_export, include_signatures=False)
        
        data = json.loads(json_str)
        
        assert 'verifier_signatures' not in data
    
    def test_export_certificate_csv(self, exporter, sample_export):
        """Test exporting certificate as CSV."""
        csv_str = exporter.export_certificate_csv(sample_export)
        
        reader = csv.DictReader(StringIO(csv_str))
        rows = list(reader)
        
        assert len(rows) == 2  # One row per hour
        assert rows[0]['cert_id'] == '1'
        assert rows[0]['hour_id'] == '500000'
        assert rows[0]['amount_wh'] == '1000000'
        assert rows[1]['hour_id'] == '500001'
        assert rows[1]['amount_wh'] == '500000'
    
    def test_export_signatures_csv(self, exporter, sample_export):
        """Test exporting signatures as CSV."""
        csv_str = exporter.export_signatures_csv(sample_export)
        
        reader = csv.DictReader(StringIO(csv_str))
        rows = list(reader)
        
        assert len(rows) == 1
        assert rows[0]['cert_id'] == '1'
        assert rows[0]['hour_id'] == '500000'
        assert rows[0]['verifier_address'] == '0x1111111111111111111111111111111111111111'
    
    def test_build_certificate_export(self, exporter):
        """Test building a complete certificate export."""
        # Mock certificate details
        mock_cert = (
            '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266',
            [500000],
            [1000000],
            [bytes.fromhex('ab' * 32)],
            ['0x1111111111111111111111111111111111111111'],
            [bytes.fromhex('cd' * 32)],
            1000000,
            bytes.fromhex('ef' * 32),
            1700000000
        )
        exporter.retirement.functions.getCertificate.return_value.call.return_value = mock_cert
        
        # Mock claim bucket
        mock_bucket = (
            1700000100, 1, 3, True, False, 1000000, 1000000,
            bytes.fromhex('12' * 32), bytes.fromhex('ab' * 32), 7, 1
        )
        exporter.production_oracle.functions.getClaimBucket.return_value.call.return_value = mock_bucket
        
        # Mock snapshot verifiers
        exporter.registry.functions.getSnapshotVerifiers.return_value.call.return_value = [
            '0x1111111111111111111111111111111111111111'
        ]
        
        event = CertificateIssuedEvent(
            cert_id=1,
            owner='0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266',
            total_mwh=1,
            metadata_hash='0x' + 'ef' * 32,
            claim_keys=['0x' + 'cd' * 32],
            tx_hash='0x' + '34' * 32,
            block_number=50,
            log_index=0
        )
        
        export = exporter.build_certificate_export(event)
        
        assert export is not None
        assert export.cert_id == 1
        assert export.total_wh == 1000000
        assert len(export.winning_verifier_addresses) >= 1


class TestSaveExportBundle:
    """Tests for saving export bundles to files."""
    
    @pytest.fixture
    def mock_web3(self):
        """Create a mock Web3 instance."""
        web3 = MagicMock()
        web3.eth.chain_id = 31337
        web3.eth.block_number = 100
        return web3
    
    @pytest.fixture
    def evidence_store(self):
        """Create an in-memory evidence store."""
        return InMemoryEvidenceStore()
    
    @pytest.fixture
    def exporter(self, mock_web3, evidence_store):
        """Create a RegistryExporter with mocks."""
        return RegistryExporter(
            web3=mock_web3,
            retirement_address="0x1111111111111111111111111111111111111111",
            registry_address="0x2222222222222222222222222222222222222222",
            production_oracle_address="0x3333333333333333333333333333333333333333",
            evidence_store=evidence_store
        )
    
    @pytest.fixture
    def sample_export(self):
        """Create a sample certificate export."""
        return CertificateExport(
            cert_id=1,
            owner='0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266',
            hour_ids=[500000],
            amounts=[1000000],
            evidence_roots=['0x' + 'ab' * 32],
            winning_verifier_addresses=['0x1111111111111111111111111111111111111111'],
            claim_keys=['0x' + 'cd' * 32],
            total_wh=1000000,
            total_mwh=1,
            metadata_hash='0x' + 'ef' * 32,
            timestamp=1700000000,
            tx_hash='0x' + '12' * 32,
            block_number=50,
            chain_id=31337,
            verifier_signatures=[]
        )
    
    def test_save_export_bundle_json(self, exporter, sample_export):
        """Test saving JSON export."""
        with tempfile.TemporaryDirectory() as tmpdir:
            saved = exporter.save_export_bundle(sample_export, tmpdir, formats=['json'])
            
            assert 'json' in saved
            assert os.path.exists(saved['json'])
            
            with open(saved['json']) as f:
                data = json.load(f)
                assert data['cert_id'] == 1
    
    def test_save_export_bundle_csv(self, exporter, sample_export):
        """Test saving CSV export."""
        with tempfile.TemporaryDirectory() as tmpdir:
            saved = exporter.save_export_bundle(sample_export, tmpdir, formats=['csv'])
            
            assert 'csv' in saved
            assert os.path.exists(saved['csv'])
    
    def test_save_export_bundle_all_formats(self, exporter, sample_export):
        """Test saving all export formats."""
        with tempfile.TemporaryDirectory() as tmpdir:
            saved = exporter.save_export_bundle(sample_export, tmpdir)
            
            assert 'json' in saved
            assert 'csv' in saved
            assert 'signatures_csv' in saved
            assert len(saved) == 3



class TestAuditTrailReconstruction:
    """Tests for audit trail reconstruction."""
    
    @pytest.fixture
    def mock_web3(self):
        """Create a mock Web3 instance."""
        web3 = MagicMock()
        web3.eth.chain_id = 31337
        web3.eth.block_number = 100
        return web3
    
    @pytest.fixture
    def evidence_store(self):
        """Create an in-memory evidence store with test data."""
        store = InMemoryEvidenceStore()
        
        store.insert_evidence(Evidence(
            id=None,
            evidence_root='0x' + 'ab' * 32,
            verifier_address='0x1111111111111111111111111111111111111111',
            system_id='system_1',
            hour_id=500000,
            raw_response={'energy': 1000000},
            canonical_json='{"energy":1000000}',
            canonical_hash='0x' + 'cd' * 32,
            signature='0x' + 'ef' * 65
        ))
        
        return store
    
    @pytest.fixture
    def exporter(self, mock_web3, evidence_store):
        """Create a RegistryExporter with mocks."""
        return RegistryExporter(
            web3=mock_web3,
            retirement_address="0x1111111111111111111111111111111111111111",
            registry_address="0x2222222222222222222222222222222222222222",
            production_oracle_address="0x3333333333333333333333333333333333333333",
            evidence_store=evidence_store
        )
    
    def test_reconstruct_audit_trail(self, exporter):
        """Test reconstructing audit trail for a certificate."""
        # Mock certificate details
        mock_cert = (
            '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266',
            [500000],
            [1000000],
            [bytes.fromhex('ab' * 32)],
            ['0x1111111111111111111111111111111111111111'],
            [bytes.fromhex('cd' * 32)],
            1000000,
            bytes.fromhex('ef' * 32),
            1700000000
        )
        exporter.retirement.functions.getCertificate.return_value.call.return_value = mock_cert
        
        # Mock claim bucket
        mock_bucket = (
            1700000100, 1, 3, True, False, 1000000, 1000000,
            bytes.fromhex('12' * 32), bytes.fromhex('ab' * 32), 7, 1
        )
        exporter.production_oracle.functions.getClaimBucket.return_value.call.return_value = mock_bucket
        
        # Mock snapshot verifiers
        exporter.registry.functions.getSnapshotVerifiers.return_value.call.return_value = [
            '0x1111111111111111111111111111111111111111'
        ]
        
        audit_trail = exporter.reconstruct_audit_trail(1)
        
        assert audit_trail is not None
        assert audit_trail['certificate']['cert_id'] == 1
        assert audit_trail['certificate']['total_wh'] == 1000000
        assert len(audit_trail['hours']) == 1
        assert audit_trail['hours'][0]['hour_id'] == 500000
        assert 'claim_bucket' in audit_trail['hours'][0]
        assert len(audit_trail['verifier_signatures']) >= 1
    
    def test_reconstruct_audit_trail_not_found(self, exporter):
        """Test reconstructing audit trail for non-existent certificate."""
        exporter.retirement.functions.getCertificate.return_value.call.side_effect = Exception("Not found")
        
        audit_trail = exporter.reconstruct_audit_trail(999)
        
        assert audit_trail is None
    
    def test_verify_audit_trail_valid(self, exporter):
        """Test verifying a valid audit trail."""
        audit_trail = {
            'certificate': {
                'cert_id': 1,
                'owner': '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266',
                'total_wh': 1000000
            },
            'hours': [
                {
                    'hour_id': 500000,
                    'amount_wh': 1000000,
                    'claim_bucket': {
                        'finalized': True,
                        'disputed': False
                    }
                }
            ],
            'verifier_signatures': [
                {
                    'signature': '0x' + 'ab' * 65,
                    'evidence_root': '0x' + 'cd' * 32
                }
            ]
        }
        
        result = exporter.verify_audit_trail(audit_trail)
        
        assert result['valid'] is True
        assert result['hours_verified'] == 1
        assert result['signatures_verified'] == 1
        assert len(result['errors']) == 0
    
    def test_verify_audit_trail_not_finalized(self, exporter):
        """Test verifying audit trail with unfinalized claim."""
        audit_trail = {
            'certificate': {'cert_id': 1},
            'hours': [
                {
                    'hour_id': 500000,
                    'claim_bucket': {
                        'finalized': False,
                        'disputed': False
                    }
                }
            ],
            'verifier_signatures': []
        }
        
        result = exporter.verify_audit_trail(audit_trail)
        
        assert result['valid'] is False
        assert len(result['errors']) > 0
        assert 'not finalized' in result['errors'][0]
    
    def test_verify_audit_trail_disputed(self, exporter):
        """Test verifying audit trail with disputed claim."""
        audit_trail = {
            'certificate': {'cert_id': 1},
            'hours': [
                {
                    'hour_id': 500000,
                    'claim_bucket': {
                        'finalized': True,
                        'disputed': True
                    }
                }
            ],
            'verifier_signatures': []
        }
        
        result = exporter.verify_audit_trail(audit_trail)
        
        assert result['valid'] is True  # Disputed but finalized is still valid
        assert len(result['warnings']) > 0
        assert 'disputed' in result['warnings'][0]
    
    def test_verify_audit_trail_missing_bucket(self, exporter):
        """Test verifying audit trail with missing claim bucket."""
        audit_trail = {
            'certificate': {'cert_id': 1},
            'hours': [
                {
                    'hour_id': 500000
                    # No claim_bucket
                }
            ],
            'verifier_signatures': []
        }
        
        result = exporter.verify_audit_trail(audit_trail)
        
        assert result['valid'] is True  # Missing bucket is a warning, not error
        assert len(result['warnings']) > 0


class TestFactoryFunctions:
    """Tests for factory functions."""
    
    def test_create_exporter_from_env_missing_retirement(self):
        """Test error when retirement address is missing."""
        mock_web3 = MagicMock()
        evidence_store = InMemoryEvidenceStore()
        
        with patch.dict(os.environ, {}, clear=True):
            with pytest.raises(ValueError, match="RETIREMENT_ADDRESS"):
                create_exporter_from_env(mock_web3, evidence_store)
    
    def test_create_exporter_from_env_missing_registry(self):
        """Test error when registry address is missing."""
        mock_web3 = MagicMock()
        evidence_store = InMemoryEvidenceStore()
        
        with patch.dict(os.environ, {
            'RETIREMENT_ADDRESS': '0x1111111111111111111111111111111111111111'
        }, clear=True):
            with pytest.raises(ValueError, match="REGISTRY_ADDRESS"):
                create_exporter_from_env(mock_web3, evidence_store)
    
    def test_create_exporter_from_env_missing_oracle(self):
        """Test error when production oracle address is missing."""
        mock_web3 = MagicMock()
        evidence_store = InMemoryEvidenceStore()
        
        with patch.dict(os.environ, {
            'RETIREMENT_ADDRESS': '0x1111111111111111111111111111111111111111',
            'REGISTRY_ADDRESS': '0x2222222222222222222222222222222222222222'
        }, clear=True):
            with pytest.raises(ValueError, match="PRODUCTION_ORACLE_ADDRESS"):
                create_exporter_from_env(mock_web3, evidence_store)
    
    def test_create_exporter_from_env_success(self):
        """Test successful creation from environment."""
        mock_web3 = MagicMock()
        mock_web3.eth.chain_id = 31337
        evidence_store = InMemoryEvidenceStore()
        
        with patch.dict(os.environ, {
            'RETIREMENT_ADDRESS': '0x1111111111111111111111111111111111111111',
            'REGISTRY_ADDRESS': '0x2222222222222222222222222222222222222222',
            'PRODUCTION_ORACLE_ADDRESS': '0x3333333333333333333333333333333333333333'
        }, clear=True):
            exporter = create_exporter_from_env(mock_web3, evidence_store)
            
            assert exporter is not None
            assert exporter.chain_id == 31337
    
    def test_create_exporter_from_addresses(self):
        """Test creating exporter from addresses dict."""
        mock_web3 = MagicMock()
        mock_web3.eth.chain_id = 31337
        evidence_store = InMemoryEvidenceStore()
        
        addresses = {
            'retirement': '0x1111111111111111111111111111111111111111',
            'registry': '0x2222222222222222222222222222222222222222',
            'productionOracle': '0x3333333333333333333333333333333333333333'
        }
        
        exporter = create_exporter_from_addresses(mock_web3, addresses, evidence_store)
        
        assert exporter is not None
        assert exporter.chain_id == 31337


class TestCertificateExportDataclass:
    """Tests for CertificateExport dataclass."""
    
    def test_certificate_export_creation(self):
        """Test creating a CertificateExport."""
        export = CertificateExport(
            cert_id=1,
            owner='0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266',
            hour_ids=[500000],
            amounts=[1000000],
            evidence_roots=['0x' + 'ab' * 32],
            winning_verifier_addresses=['0x1111111111111111111111111111111111111111'],
            claim_keys=['0x' + 'cd' * 32],
            total_wh=1000000,
            total_mwh=1,
            metadata_hash='0x' + 'ef' * 32,
            timestamp=1700000000,
            tx_hash='0x' + '12' * 32,
            block_number=50,
            chain_id=31337
        )
        
        assert export.cert_id == 1
        assert export.total_wh == 1000000
        assert export.total_mwh == 1
        assert len(export.verifier_signatures) == 0  # Default empty list
    
    def test_certificate_export_with_signatures(self):
        """Test CertificateExport with signatures."""
        export = CertificateExport(
            cert_id=1,
            owner='0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266',
            hour_ids=[500000],
            amounts=[1000000],
            evidence_roots=['0x' + 'ab' * 32],
            winning_verifier_addresses=['0x1111111111111111111111111111111111111111'],
            claim_keys=['0x' + 'cd' * 32],
            total_wh=1000000,
            total_mwh=1,
            metadata_hash='0x' + 'ef' * 32,
            timestamp=1700000000,
            tx_hash='0x' + '12' * 32,
            block_number=50,
            chain_id=31337,
            verifier_signatures=[
                {'verifier': '0x1111111111111111111111111111111111111111', 'sig': '0xabc'}
            ]
        )
        
        assert len(export.verifier_signatures) == 1


class TestCertificateIssuedEventDataclass:
    """Tests for CertificateIssuedEvent dataclass."""
    
    def test_event_creation(self):
        """Test creating a CertificateIssuedEvent."""
        event = CertificateIssuedEvent(
            cert_id=1,
            owner='0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266',
            total_mwh=2,
            metadata_hash='0x' + 'ab' * 32,
            claim_keys=['0x' + 'cd' * 32, '0x' + 'ef' * 32],
            tx_hash='0x' + '12' * 32,
            block_number=100,
            log_index=0
        )
        
        assert event.cert_id == 1
        assert event.total_mwh == 2
        assert len(event.claim_keys) == 2
        assert event.block_number == 100
