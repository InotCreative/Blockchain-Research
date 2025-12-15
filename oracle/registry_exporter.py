"""
Registry Export Adapter for SEARChain.

This module handles exporting certificate bundles in standard formats
for integration with M-RETS/PJM GATS registries.

Requirements: 11.1, 11.2, 11.3, 7.6, 7.7
"""

import os
import csv
import json
import logging
from datetime import datetime, timezone
from typing import Dict, List, Optional, Any, Union
from dataclasses import dataclass, field, asdict
from io import StringIO

from web3 import Web3
from web3.types import LogReceipt

from oracle.evidence_store import EvidenceStore, InMemoryEvidenceStore, Evidence

# Configure logging
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)


@dataclass
class CertificateExport:
    """Exported certificate data bundle."""
    cert_id: int
    owner: str
    hour_ids: List[int]
    amounts: List[int]  # Wh
    evidence_roots: List[str]
    winning_verifier_addresses: List[str]
    claim_keys: List[str]
    total_wh: int
    total_mwh: int
    metadata_hash: str
    timestamp: int
    tx_hash: str
    block_number: int
    chain_id: int
    # Verifier signatures from evidence DB
    verifier_signatures: List[Dict[str, Any]] = field(default_factory=list)


@dataclass
class CertificateIssuedEvent:
    """Parsed CertificateIssued event."""
    cert_id: int
    owner: str
    total_mwh: int
    metadata_hash: str
    claim_keys: List[str]
    tx_hash: str
    block_number: int
    log_index: int


class RegistryExporter:
    """
    Exports certificate bundles for registry integration.
    
    Listens to CertificateIssued events from the Retirement contract,
    queries on-chain certificate details, retrieves verifier signatures
    from the evidence database, and generates JSON/CSV export bundles.
    """
    
    # Retirement contract ABI (minimal for export)
    RETIREMENT_ABI = [
        {
            "anonymous": False,
            "inputs": [
                {"indexed": True, "name": "certId", "type": "uint256"},
                {"indexed": True, "name": "owner", "type": "address"},
                {"indexed": False, "name": "totalMwh", "type": "uint64"},
                {"indexed": False, "name": "metadataHash", "type": "bytes32"},
                {"indexed": False, "name": "claimKeys", "type": "bytes32[]"}
            ],
            "name": "CertificateIssued",
            "type": "event"
        },
        {
            "inputs": [{"name": "certId", "type": "uint256"}],
            "name": "getCertificate",
            "outputs": [
                {
                    "components": [
                        {"name": "owner", "type": "address"},
                        {"name": "hourIds", "type": "uint256[]"},
                        {"name": "amounts", "type": "uint64[]"},
                        {"name": "evidenceRoots", "type": "bytes32[]"},
                        {"name": "winningVerifiers", "type": "address[]"},
                        {"name": "claimKeys", "type": "bytes32[]"},
                        {"name": "totalWh", "type": "uint64"},
                        {"name": "metadataHash", "type": "bytes32"},
                        {"name": "timestamp", "type": "uint256"}
                    ],
                    "name": "",
                    "type": "tuple"
                }
            ],
            "stateMutability": "view",
            "type": "function"
        }
    ]
    
    # Registry contract ABI (for snapshot verifiers)
    REGISTRY_ABI = [
        {
            "inputs": [{"name": "snapshotId", "type": "uint256"}],
            "name": "getSnapshotVerifiers",
            "outputs": [{"name": "", "type": "address[]"}],
            "stateMutability": "view",
            "type": "function"
        }
    ]
    
    # ProductionOracle ABI (for claim bucket data)
    PRODUCTION_ORACLE_ABI = [
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
    
    def __init__(
        self,
        web3: Web3,
        retirement_address: str,
        registry_address: str,
        production_oracle_address: str,
        evidence_store: Union[EvidenceStore, InMemoryEvidenceStore]
    ):
        """
        Initialize registry exporter.
        
        Args:
            web3: Web3 instance
            retirement_address: Retirement contract address
            registry_address: Registry contract address
            production_oracle_address: ProductionOracle contract address
            evidence_store: Evidence store for retrieving signatures
        """
        self.web3 = web3
        self.chain_id = web3.eth.chain_id
        self.evidence_store = evidence_store
        
        # Initialize contracts
        self.retirement = web3.eth.contract(
            address=Web3.to_checksum_address(retirement_address),
            abi=self.RETIREMENT_ABI
        )
        self.registry = web3.eth.contract(
            address=Web3.to_checksum_address(registry_address),
            abi=self.REGISTRY_ABI
        )
        self.production_oracle = web3.eth.contract(
            address=Web3.to_checksum_address(production_oracle_address),
            abi=self.PRODUCTION_ORACLE_ABI
        )
        
        # Event tracking
        self._last_processed_block = 0
        self._processed_events: List[CertificateIssuedEvent] = []


    # ============ Event Listening ============
    
    def get_certificate_events(
        self,
        from_block: int = 0,
        to_block: Optional[int] = None
    ) -> List[CertificateIssuedEvent]:
        """
        Get CertificateIssued events from the Retirement contract.
        
        Args:
            from_block: Starting block number
            to_block: Ending block number (None for latest)
            
        Returns:
            List of parsed CertificateIssuedEvent objects
        """
        if to_block is None:
            to_block = self.web3.eth.block_number
        
        try:
            # Get event filter
            event_filter = self.retirement.events.CertificateIssued.create_filter(
                fromBlock=from_block,
                toBlock=to_block
            )
            
            events = event_filter.get_all_entries()
            parsed_events = []
            
            for event in events:
                parsed = self._parse_certificate_event(event)
                if parsed:
                    parsed_events.append(parsed)
            
            logger.info(f"Found {len(parsed_events)} CertificateIssued events from block {from_block} to {to_block}")
            return parsed_events
            
        except Exception as e:
            logger.error(f"Error fetching certificate events: {e}")
            return []
    
    def _parse_certificate_event(self, event: LogReceipt) -> Optional[CertificateIssuedEvent]:
        """
        Parse a CertificateIssued event log.
        
        Args:
            event: Raw event log
            
        Returns:
            Parsed CertificateIssuedEvent or None if parsing fails
        """
        try:
            args = event['args']
            
            # Convert claim keys to hex strings
            claim_keys = [
                '0x' + ck.hex() if isinstance(ck, bytes) else ck
                for ck in args['claimKeys']
            ]
            
            # Convert metadata hash
            metadata_hash = args['metadataHash']
            if isinstance(metadata_hash, bytes):
                metadata_hash = '0x' + metadata_hash.hex()
            
            return CertificateIssuedEvent(
                cert_id=args['certId'],
                owner=args['owner'],
                total_mwh=args['totalMwh'],
                metadata_hash=metadata_hash,
                claim_keys=claim_keys,
                tx_hash=event['transactionHash'].hex() if isinstance(event['transactionHash'], bytes) else event['transactionHash'],
                block_number=event['blockNumber'],
                log_index=event['logIndex']
            )
        except Exception as e:
            logger.error(f"Error parsing certificate event: {e}")
            return None
    
    def listen_for_events(
        self,
        callback: Optional[callable] = None,
        from_block: Optional[int] = None
    ) -> List[CertificateIssuedEvent]:
        """
        Listen for new CertificateIssued events since last check.
        
        Args:
            callback: Optional callback function for each event
            from_block: Override starting block (uses last processed if None)
            
        Returns:
            List of new events
        """
        start_block = from_block if from_block is not None else self._last_processed_block + 1
        current_block = self.web3.eth.block_number
        
        if start_block > current_block:
            return []
        
        events = self.get_certificate_events(start_block, current_block)
        
        for event in events:
            self._processed_events.append(event)
            if callback:
                try:
                    callback(event)
                except Exception as e:
                    logger.error(f"Error in event callback: {e}")
        
        self._last_processed_block = current_block
        return events
    
    # ============ Certificate Data Retrieval ============
    
    def get_certificate_details(self, cert_id: int) -> Optional[Dict[str, Any]]:
        """
        Get certificate details from the Retirement contract.
        
        Args:
            cert_id: Certificate ID
            
        Returns:
            Certificate details dict or None if not found
        """
        try:
            cert = self.retirement.functions.getCertificate(cert_id).call()
            
            # Parse the tuple response
            return {
                'owner': cert[0],
                'hour_ids': list(cert[1]),
                'amounts': list(cert[2]),
                'evidence_roots': [
                    '0x' + er.hex() if isinstance(er, bytes) else er
                    for er in cert[3]
                ],
                'winning_verifiers': list(cert[4]),
                'claim_keys': [
                    '0x' + ck.hex() if isinstance(ck, bytes) else ck
                    for ck in cert[5]
                ],
                'total_wh': cert[6],
                'metadata_hash': '0x' + cert[7].hex() if isinstance(cert[7], bytes) else cert[7],
                'timestamp': cert[8]
            }
        except Exception as e:
            logger.error(f"Error getting certificate {cert_id}: {e}")
            return None
    
    def get_claim_bucket(self, claim_key: str) -> Optional[Dict[str, Any]]:
        """
        Get claim bucket data from ProductionOracle.
        
        Args:
            claim_key: Claim key (hex string)
            
        Returns:
            Claim bucket dict or None if not found
        """
        try:
            claim_key_bytes = bytes.fromhex(claim_key[2:] if claim_key.startswith('0x') else claim_key)
            bucket = self.production_oracle.functions.getClaimBucket(claim_key_bytes).call()
            
            return {
                'deadline': bucket[0],
                'snapshot_id': bucket[1],
                'submission_count': bucket[2],
                'finalized': bucket[3],
                'disputed': bucket[4],
                'verified_energy_wh': bucket[5],
                'max_submitted_energy_wh': bucket[6],
                'winning_value_hash': '0x' + bucket[7].hex() if isinstance(bucket[7], bytes) else bucket[7],
                'evidence_root': '0x' + bucket[8].hex() if isinstance(bucket[8], bytes) else bucket[8],
                'all_submitters_bitmap': bucket[9],
                'winning_verifier_bitmap': bucket[10]
            }
        except Exception as e:
            logger.error(f"Error getting claim bucket for {claim_key}: {e}")
            return None
    
    def get_snapshot_verifiers(self, snapshot_id: int) -> List[str]:
        """
        Get verifier addresses from a snapshot.
        
        Args:
            snapshot_id: Snapshot ID
            
        Returns:
            List of verifier addresses
        """
        try:
            verifiers = self.registry.functions.getSnapshotVerifiers(snapshot_id).call()
            return list(verifiers)
        except Exception as e:
            logger.error(f"Error getting snapshot verifiers for {snapshot_id}: {e}")
            return []
    
    def get_winning_verifiers_from_bitmap(
        self,
        snapshot_id: int,
        bitmap: int
    ) -> List[str]:
        """
        Resolve winning verifier addresses from bitmap.
        
        Args:
            snapshot_id: Snapshot ID
            bitmap: Winning verifier bitmap
            
        Returns:
            List of winning verifier addresses
        """
        all_verifiers = self.get_snapshot_verifiers(snapshot_id)
        winners = []
        
        for i, verifier in enumerate(all_verifiers):
            if bitmap & (1 << i):
                winners.append(verifier)
        
        return winners


    # ============ Evidence Retrieval ============
    
    def get_verifier_signatures(
        self,
        hour_ids: List[int],
        evidence_roots: List[str]
    ) -> List[Dict[str, Any]]:
        """
        Retrieve verifier signatures from evidence database.
        
        Args:
            hour_ids: List of hour IDs
            evidence_roots: List of evidence roots
            
        Returns:
            List of signature records with verifier info
        """
        signatures = []
        
        for hour_id, evidence_root in zip(hour_ids, evidence_roots):
            # Get evidence by hour
            evidence_list = self.evidence_store.get_evidence_by_hour(hour_id)
            
            for evidence in evidence_list:
                # Match by evidence root if available
                if evidence.evidence_root == evidence_root or evidence_root == evidence.evidence_root:
                    signatures.append({
                        'hour_id': hour_id,
                        'evidence_root': evidence.evidence_root,
                        'verifier_address': evidence.verifier_address,
                        'signature': evidence.signature,
                        'canonical_hash': evidence.canonical_hash,
                        'system_id': evidence.system_id,
                        'created_at': evidence.created_at.isoformat() if evidence.created_at else None
                    })
        
        return signatures
    
    def get_signatures_by_evidence_root(self, evidence_root: str) -> Optional[Dict[str, Any]]:
        """
        Get signature data for a specific evidence root.
        
        Args:
            evidence_root: Evidence root hash
            
        Returns:
            Signature record or None
        """
        evidence = self.evidence_store.get_evidence_by_root(evidence_root)
        
        if evidence:
            return {
                'evidence_root': evidence.evidence_root,
                'verifier_address': evidence.verifier_address,
                'signature': evidence.signature,
                'canonical_hash': evidence.canonical_hash,
                'system_id': evidence.system_id,
                'hour_id': evidence.hour_id,
                'raw_response': evidence.raw_response,
                'created_at': evidence.created_at.isoformat() if evidence.created_at else None
            }
        
        return None
    
    # ============ Export Bundle Generation ============
    
    def build_certificate_export(
        self,
        event: CertificateIssuedEvent
    ) -> Optional[CertificateExport]:
        """
        Build a complete certificate export bundle.
        
        Args:
            event: CertificateIssued event
            
        Returns:
            CertificateExport bundle or None if data unavailable
        """
        # Get on-chain certificate details
        cert_details = self.get_certificate_details(event.cert_id)
        if not cert_details:
            logger.error(f"Could not get certificate details for cert {event.cert_id}")
            return None
        
        # Get winning verifier addresses
        winning_verifiers = []
        for claim_key in cert_details['claim_keys']:
            bucket = self.get_claim_bucket(claim_key)
            if bucket and bucket['snapshot_id'] > 0:
                verifiers = self.get_winning_verifiers_from_bitmap(
                    bucket['snapshot_id'],
                    bucket['winning_verifier_bitmap']
                )
                winning_verifiers.extend(verifiers)
        
        # Deduplicate verifiers
        winning_verifiers = list(set(winning_verifiers))
        
        # Get verifier signatures from evidence DB
        verifier_signatures = self.get_verifier_signatures(
            cert_details['hour_ids'],
            cert_details['evidence_roots']
        )
        
        return CertificateExport(
            cert_id=event.cert_id,
            owner=cert_details['owner'],
            hour_ids=cert_details['hour_ids'],
            amounts=cert_details['amounts'],
            evidence_roots=cert_details['evidence_roots'],
            winning_verifier_addresses=winning_verifiers,
            claim_keys=cert_details['claim_keys'],
            total_wh=cert_details['total_wh'],
            total_mwh=event.total_mwh,
            metadata_hash=cert_details['metadata_hash'],
            timestamp=cert_details['timestamp'],
            tx_hash=event.tx_hash,
            block_number=event.block_number,
            chain_id=self.chain_id,
            verifier_signatures=verifier_signatures
        )
    
    def export_certificate_json(
        self,
        cert_export: CertificateExport,
        include_signatures: bool = True
    ) -> str:
        """
        Export certificate as JSON string.
        
        Args:
            cert_export: Certificate export bundle
            include_signatures: Whether to include verifier signatures
            
        Returns:
            JSON string
        """
        data = asdict(cert_export)
        
        if not include_signatures:
            data.pop('verifier_signatures', None)
        
        # Add export metadata
        data['export_timestamp'] = datetime.now(timezone.utc).isoformat()
        data['export_version'] = '1.0'
        
        return json.dumps(data, indent=2, default=str)
    
    def export_certificate_csv(
        self,
        cert_export: CertificateExport
    ) -> str:
        """
        Export certificate as CSV string.
        
        Creates a row per hour with certificate metadata.
        
        Args:
            cert_export: Certificate export bundle
            
        Returns:
            CSV string
        """
        output = StringIO()
        
        fieldnames = [
            'cert_id', 'owner', 'hour_id', 'amount_wh', 'evidence_root',
            'claim_key', 'total_wh', 'total_mwh', 'metadata_hash',
            'timestamp', 'tx_hash', 'block_number', 'chain_id'
        ]
        
        writer = csv.DictWriter(output, fieldnames=fieldnames)
        writer.writeheader()
        
        # Write a row per hour
        for i, hour_id in enumerate(cert_export.hour_ids):
            writer.writerow({
                'cert_id': cert_export.cert_id,
                'owner': cert_export.owner,
                'hour_id': hour_id,
                'amount_wh': cert_export.amounts[i] if i < len(cert_export.amounts) else 0,
                'evidence_root': cert_export.evidence_roots[i] if i < len(cert_export.evidence_roots) else '',
                'claim_key': cert_export.claim_keys[i] if i < len(cert_export.claim_keys) else '',
                'total_wh': cert_export.total_wh,
                'total_mwh': cert_export.total_mwh,
                'metadata_hash': cert_export.metadata_hash,
                'timestamp': cert_export.timestamp,
                'tx_hash': cert_export.tx_hash,
                'block_number': cert_export.block_number,
                'chain_id': cert_export.chain_id
            })
        
        return output.getvalue()
    
    def export_signatures_csv(
        self,
        cert_export: CertificateExport
    ) -> str:
        """
        Export verifier signatures as CSV string.
        
        Args:
            cert_export: Certificate export bundle
            
        Returns:
            CSV string
        """
        output = StringIO()
        
        fieldnames = [
            'cert_id', 'hour_id', 'evidence_root', 'verifier_address',
            'signature', 'canonical_hash', 'system_id', 'created_at'
        ]
        
        writer = csv.DictWriter(output, fieldnames=fieldnames)
        writer.writeheader()
        
        for sig in cert_export.verifier_signatures:
            writer.writerow({
                'cert_id': cert_export.cert_id,
                'hour_id': sig.get('hour_id', ''),
                'evidence_root': sig.get('evidence_root', ''),
                'verifier_address': sig.get('verifier_address', ''),
                'signature': sig.get('signature', ''),
                'canonical_hash': sig.get('canonical_hash', ''),
                'system_id': sig.get('system_id', ''),
                'created_at': sig.get('created_at', '')
            })
        
        return output.getvalue()
    
    def save_export_bundle(
        self,
        cert_export: CertificateExport,
        output_dir: str,
        formats: List[str] = None
    ) -> Dict[str, str]:
        """
        Save certificate export bundle to files.
        
        Args:
            cert_export: Certificate export bundle
            output_dir: Output directory path
            formats: List of formats to export ('json', 'csv', 'signatures_csv')
            
        Returns:
            Dict mapping format to file path
        """
        if formats is None:
            formats = ['json', 'csv', 'signatures_csv']
        
        os.makedirs(output_dir, exist_ok=True)
        
        saved_files = {}
        base_name = f"certificate_{cert_export.cert_id}"
        
        if 'json' in formats:
            json_path = os.path.join(output_dir, f"{base_name}.json")
            with open(json_path, 'w') as f:
                f.write(self.export_certificate_json(cert_export))
            saved_files['json'] = json_path
            logger.info(f"Saved JSON export to {json_path}")
        
        if 'csv' in formats:
            csv_path = os.path.join(output_dir, f"{base_name}.csv")
            with open(csv_path, 'w', newline='') as f:
                f.write(self.export_certificate_csv(cert_export))
            saved_files['csv'] = csv_path
            logger.info(f"Saved CSV export to {csv_path}")
        
        if 'signatures_csv' in formats:
            sig_path = os.path.join(output_dir, f"{base_name}_signatures.csv")
            with open(sig_path, 'w', newline='') as f:
                f.write(self.export_signatures_csv(cert_export))
            saved_files['signatures_csv'] = sig_path
            logger.info(f"Saved signatures CSV to {sig_path}")
        
        return saved_files


    # ============ Batch Export ============
    
    def export_all_certificates(
        self,
        from_block: int = 0,
        to_block: Optional[int] = None,
        output_dir: Optional[str] = None
    ) -> List[CertificateExport]:
        """
        Export all certificates in a block range.
        
        Args:
            from_block: Starting block
            to_block: Ending block (None for latest)
            output_dir: Optional directory to save exports
            
        Returns:
            List of CertificateExport bundles
        """
        events = self.get_certificate_events(from_block, to_block)
        exports = []
        
        for event in events:
            export = self.build_certificate_export(event)
            if export:
                exports.append(export)
                
                if output_dir:
                    self.save_export_bundle(export, output_dir)
        
        logger.info(f"Exported {len(exports)} certificates")
        return exports
    
    # ============ Audit Trail Reconstruction ============
    
    def reconstruct_audit_trail(
        self,
        cert_id: int
    ) -> Optional[Dict[str, Any]]:
        """
        Reconstruct the complete audit trail for a certificate.
        
        This provides all data needed to verify the certificate's integrity:
        - On-chain certificate data
        - Claim bucket data for each hour
        - Verifier signatures from evidence DB
        - Transaction hashes
        
        Args:
            cert_id: Certificate ID
            
        Returns:
            Complete audit trail dict or None
        """
        # Get certificate details
        cert_details = self.get_certificate_details(cert_id)
        if not cert_details:
            return None
        
        # Build audit trail
        audit_trail = {
            'certificate': {
                'cert_id': cert_id,
                'owner': cert_details['owner'],
                'total_wh': cert_details['total_wh'],
                'metadata_hash': cert_details['metadata_hash'],
                'timestamp': cert_details['timestamp'],
                'chain_id': self.chain_id
            },
            'hours': [],
            'verifier_signatures': []
        }
        
        # Get data for each hour
        for i, hour_id in enumerate(cert_details['hour_ids']):
            claim_key = cert_details['claim_keys'][i] if i < len(cert_details['claim_keys']) else None
            evidence_root = cert_details['evidence_roots'][i] if i < len(cert_details['evidence_roots']) else None
            amount = cert_details['amounts'][i] if i < len(cert_details['amounts']) else 0
            
            hour_data = {
                'hour_id': hour_id,
                'amount_wh': amount,
                'claim_key': claim_key,
                'evidence_root': evidence_root
            }
            
            # Get claim bucket data
            if claim_key:
                bucket = self.get_claim_bucket(claim_key)
                if bucket:
                    hour_data['claim_bucket'] = bucket
                    
                    # Get winning verifiers
                    if bucket['snapshot_id'] > 0:
                        winners = self.get_winning_verifiers_from_bitmap(
                            bucket['snapshot_id'],
                            bucket['winning_verifier_bitmap']
                        )
                        hour_data['winning_verifiers'] = winners
            
            audit_trail['hours'].append(hour_data)
        
        # Get verifier signatures
        audit_trail['verifier_signatures'] = self.get_verifier_signatures(
            cert_details['hour_ids'],
            cert_details['evidence_roots']
        )
        
        return audit_trail
    
    def verify_audit_trail(
        self,
        audit_trail: Dict[str, Any]
    ) -> Dict[str, Any]:
        """
        Verify the integrity of an audit trail.
        
        Checks:
        - All hours have claim data
        - All claims are finalized
        - Signatures match evidence roots
        
        Args:
            audit_trail: Audit trail dict
            
        Returns:
            Verification result dict
        """
        result = {
            'valid': True,
            'errors': [],
            'warnings': [],
            'hours_verified': 0,
            'signatures_verified': 0
        }
        
        # Check each hour
        for hour_data in audit_trail.get('hours', []):
            hour_id = hour_data.get('hour_id')
            
            # Check claim bucket exists
            if 'claim_bucket' not in hour_data:
                result['warnings'].append(f"Hour {hour_id}: No claim bucket data")
                continue
            
            bucket = hour_data['claim_bucket']
            
            # Check finalized
            if not bucket.get('finalized'):
                result['errors'].append(f"Hour {hour_id}: Claim not finalized")
                result['valid'] = False
                continue
            
            # Check not disputed
            if bucket.get('disputed'):
                result['warnings'].append(f"Hour {hour_id}: Claim was disputed")
            
            result['hours_verified'] += 1
        
        # Check signatures
        for sig in audit_trail.get('verifier_signatures', []):
            if sig.get('signature') and sig.get('evidence_root'):
                result['signatures_verified'] += 1
        
        return result


# ============ Factory Functions ============

def create_exporter_from_env(
    web3: Web3,
    evidence_store: Union[EvidenceStore, InMemoryEvidenceStore]
) -> RegistryExporter:
    """
    Create a RegistryExporter from environment variables.
    
    Required env vars:
    - RETIREMENT_ADDRESS: Retirement contract address
    - REGISTRY_ADDRESS: Registry contract address
    - PRODUCTION_ORACLE_ADDRESS: ProductionOracle contract address
    
    Args:
        web3: Web3 instance
        evidence_store: Evidence store instance
        
    Returns:
        Configured RegistryExporter
    """
    retirement_address = os.getenv("RETIREMENT_ADDRESS")
    if not retirement_address:
        raise ValueError("RETIREMENT_ADDRESS environment variable required")
    
    registry_address = os.getenv("REGISTRY_ADDRESS")
    if not registry_address:
        raise ValueError("REGISTRY_ADDRESS environment variable required")
    
    production_oracle_address = os.getenv("PRODUCTION_ORACLE_ADDRESS")
    if not production_oracle_address:
        raise ValueError("PRODUCTION_ORACLE_ADDRESS environment variable required")
    
    return RegistryExporter(
        web3=web3,
        retirement_address=retirement_address,
        registry_address=registry_address,
        production_oracle_address=production_oracle_address,
        evidence_store=evidence_store
    )


def create_exporter_from_addresses(
    web3: Web3,
    addresses: Dict[str, str],
    evidence_store: Union[EvidenceStore, InMemoryEvidenceStore]
) -> RegistryExporter:
    """
    Create a RegistryExporter from an addresses dict.
    
    Args:
        web3: Web3 instance
        addresses: Dict with 'retirement', 'registry', 'productionOracle' keys
        evidence_store: Evidence store instance
        
    Returns:
        Configured RegistryExporter
    """
    return RegistryExporter(
        web3=web3,
        retirement_address=addresses['retirement'],
        registry_address=addresses['registry'],
        production_oracle_address=addresses['productionOracle'],
        evidence_store=evidence_store
    )
