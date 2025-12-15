"""
Consumption Data Client for SEARChain Oracle Service.

This module handles parsing CSV consumption data and submitting
claims to the ConsumptionOracle contract.

Requirements: 10.1, 10.2, 10.3, 10.4
"""

import csv
import json
import logging
from datetime import datetime, timezone
from pathlib import Path
from typing import Dict, List, Optional, Any, Iterator
from dataclasses import dataclass

from eth_hash.auto import keccak

from .enphase_client import RFC8785Canonicalizer
from .submitter import ClaimData, ClaimSigner, ClaimSubmitter, ClaimType
from .evidence_store import Evidence, ClaimSubmission, EvidenceStore

# Configure logging
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)


@dataclass
class ConsumptionRecord:
    """Represents a single consumption record from CSV."""
    consumer_id: str  # Meter ID or consumer identifier
    hour_id: int  # floor(unix_timestamp / 3600)
    energy_wh: int  # Consumption in Wh
    timestamp: datetime  # Original timestamp
    raw_data: Dict[str, Any]  # Original CSV row as dict


@dataclass
class HourlyConsumption:
    """Processed hourly consumption data ready for submission."""
    consumer_id: str
    consumer_id_hash: str  # keccak256 of consumer_id
    hour_id: int
    energy_wh: int
    raw_data: Dict[str, Any]
    canonical_json: str
    canonical_hash: str
    evidence_root: str


class CSVConsumptionParser:
    """
    Parser for CSV consumption data files.
    
    Expected CSV format:
    - consumer_id: Meter ID or consumer identifier
    - timestamp: ISO 8601 timestamp or Unix timestamp
    - energy_wh: Energy consumption in Wh (or energy_kwh for kWh)
    
    Alternative column names are supported:
    - meter_id, consumer, id -> consumer_id
    - time, datetime, date -> timestamp
    - wh, consumption_wh, kwh, consumption_kwh -> energy
    """
    
    # Column name mappings
    CONSUMER_ID_COLUMNS = ['consumer_id', 'meter_id', 'consumer', 'id', 'meterid']
    TIMESTAMP_COLUMNS = ['timestamp', 'time', 'datetime', 'date', 'hour']
    ENERGY_WH_COLUMNS = ['energy_wh', 'wh', 'consumption_wh', 'energywh']
    ENERGY_KWH_COLUMNS = ['energy_kwh', 'kwh', 'consumption_kwh', 'energykwh']
    
    def __init__(self, file_path: str):
        """
        Initialize parser with CSV file path.
        
        Args:
            file_path: Path to CSV file
        """
        self.file_path = Path(file_path)
        self._column_mapping: Dict[str, str] = {}
    
    def _detect_columns(self, headers: List[str]) -> None:
        """
        Detect column mappings from headers.
        
        Args:
            headers: List of column headers
        """
        headers_lower = [h.lower().strip() for h in headers]
        
        # Find consumer_id column
        for col in self.CONSUMER_ID_COLUMNS:
            if col in headers_lower:
                self._column_mapping['consumer_id'] = headers[headers_lower.index(col)]
                break
        
        # Find timestamp column
        for col in self.TIMESTAMP_COLUMNS:
            if col in headers_lower:
                self._column_mapping['timestamp'] = headers[headers_lower.index(col)]
                break
        
        # Find energy column (prefer Wh over kWh)
        for col in self.ENERGY_WH_COLUMNS:
            if col in headers_lower:
                self._column_mapping['energy_wh'] = headers[headers_lower.index(col)]
                self._column_mapping['energy_unit'] = 'wh'
                break
        
        if 'energy_wh' not in self._column_mapping:
            for col in self.ENERGY_KWH_COLUMNS:
                if col in headers_lower:
                    self._column_mapping['energy_wh'] = headers[headers_lower.index(col)]
                    self._column_mapping['energy_unit'] = 'kwh'
                    break
        
        # Validate required columns found
        required = ['consumer_id', 'timestamp', 'energy_wh']
        missing = [col for col in required if col not in self._column_mapping]
        if missing:
            raise ValueError(f"Missing required columns: {missing}")
    
    def _parse_timestamp(self, value: str) -> datetime:
        """
        Parse timestamp from various formats.
        
        Args:
            value: Timestamp string
            
        Returns:
            datetime object in UTC
        """
        # Try Unix timestamp
        try:
            ts = int(value)
            return datetime.fromtimestamp(ts, tz=timezone.utc)
        except ValueError:
            pass
        
        # Try ISO 8601 formats
        formats = [
            '%Y-%m-%dT%H:%M:%S%z',
            '%Y-%m-%dT%H:%M:%SZ',
            '%Y-%m-%dT%H:%M:%S',
            '%Y-%m-%d %H:%M:%S%z',
            '%Y-%m-%d %H:%M:%S',
            '%Y-%m-%d %H:%M',
            '%Y-%m-%d',
        ]
        
        for fmt in formats:
            try:
                dt = datetime.strptime(value, fmt)
                if dt.tzinfo is None:
                    dt = dt.replace(tzinfo=timezone.utc)
                return dt
            except ValueError:
                continue
        
        raise ValueError(f"Unable to parse timestamp: {value}")
    
    def _parse_energy(self, value: str) -> int:
        """
        Parse energy value to Wh.
        
        Args:
            value: Energy value string
            
        Returns:
            Energy in Wh as integer
        """
        energy = float(value)
        
        # Convert kWh to Wh if needed
        if self._column_mapping.get('energy_unit') == 'kwh':
            energy *= 1000
        
        return int(energy)
    
    def parse(self) -> Iterator[ConsumptionRecord]:
        """
        Parse CSV file and yield consumption records.
        
        Yields:
            ConsumptionRecord for each row
        """
        with open(self.file_path, 'r', newline='', encoding='utf-8') as f:
            reader = csv.DictReader(f)
            
            # Detect columns from headers
            if reader.fieldnames:
                self._detect_columns(list(reader.fieldnames))
            
            for row in reader:
                try:
                    consumer_id = row[self._column_mapping['consumer_id']].strip()
                    timestamp = self._parse_timestamp(row[self._column_mapping['timestamp']])
                    energy_wh = self._parse_energy(row[self._column_mapping['energy_wh']])
                    
                    # Calculate hour_id
                    hour_id = int(timestamp.timestamp()) // 3600
                    
                    yield ConsumptionRecord(
                        consumer_id=consumer_id,
                        hour_id=hour_id,
                        energy_wh=energy_wh,
                        timestamp=timestamp,
                        raw_data=dict(row)
                    )
                except Exception as e:
                    logger.warning(f"Failed to parse row: {row}, error: {e}")
                    continue
    
    def parse_all(self) -> List[ConsumptionRecord]:
        """
        Parse all records from CSV file.
        
        Returns:
            List of ConsumptionRecord
        """
        return list(self.parse())


class ConsumptionClient:
    """
    Client for processing and submitting consumption data.
    
    Handles:
    - CSV parsing
    - Data canonicalization
    - Evidence root computation
    - Claim submission to ConsumptionOracle
    """
    
    def __init__(
        self,
        verifier_address: str,
        submitter: Optional[ClaimSubmitter] = None,
        evidence_store: Optional[EvidenceStore] = None
    ):
        """
        Initialize consumption client.
        
        Args:
            verifier_address: Verifier's Ethereum address
            submitter: Optional ClaimSubmitter for on-chain submission
            evidence_store: Optional EvidenceStore for persistence
        """
        self.verifier_address = verifier_address.lower()
        self.submitter = submitter
        self.evidence_store = evidence_store
        self.canonicalizer = RFC8785Canonicalizer()
    
    def process_record(self, record: ConsumptionRecord) -> HourlyConsumption:
        """
        Process a consumption record into submission-ready format.
        
        Args:
            record: Raw consumption record
            
        Returns:
            HourlyConsumption with canonical data and evidence root
        """
        # Compute consumer_id hash
        consumer_id_hash = self._compute_consumer_id_hash(record.consumer_id)
        
        # Canonicalize raw data
        canonical_json = self.canonicalizer.canonicalize(record.raw_data)
        canonical_hash = self.canonicalizer.compute_hash(canonical_json)
        
        # Compute evidence root
        evidence_root = self._compute_evidence_root(
            consumer_id_hash,
            record.hour_id,
            canonical_hash,
            self.verifier_address
        )
        
        return HourlyConsumption(
            consumer_id=record.consumer_id,
            consumer_id_hash=consumer_id_hash,
            hour_id=record.hour_id,
            energy_wh=record.energy_wh,
            raw_data=record.raw_data,
            canonical_json=canonical_json,
            canonical_hash=canonical_hash,
            evidence_root=evidence_root
        )
    
    def _compute_consumer_id_hash(self, consumer_id: str) -> str:
        """
        Compute keccak256 hash of consumer ID.
        
        Args:
            consumer_id: Consumer identifier
            
        Returns:
            Hex string of hash (with 0x prefix)
        """
        hash_bytes = keccak(consumer_id.encode('utf-8'))
        return '0x' + hash_bytes.hex()
    
    def _compute_evidence_root(
        self,
        consumer_id_hash: str,
        hour_id: int,
        canonical_hash: str,
        verifier_address: str
    ) -> str:
        """
        Compute evidence root for consumption data.
        
        evidenceRoot = keccak256(abi.encodePacked(
            consumerIdHash,
            hourId,
            canonicalHash,
            verifierAddress
        ))
        
        Args:
            consumer_id_hash: Hash of consumer ID
            hour_id: Hour identifier
            canonical_hash: Hash of canonical JSON
            verifier_address: Verifier's Ethereum address
            
        Returns:
            Evidence root as hex string (with 0x prefix)
        """
        # Remove 0x prefix for encoding
        consumer_id_bytes = bytes.fromhex(consumer_id_hash[2:])
        canonical_bytes = bytes.fromhex(canonical_hash[2:])
        verifier_bytes = bytes.fromhex(verifier_address[2:])
        
        # Pack the data
        packed = (
            consumer_id_bytes +
            hour_id.to_bytes(32, 'big') +
            canonical_bytes +
            verifier_bytes
        )
        
        hash_bytes = keccak(packed)
        return '0x' + hash_bytes.hex()
    
    def process_csv(self, file_path: str) -> List[HourlyConsumption]:
        """
        Process a CSV file and return all consumption records.
        
        Args:
            file_path: Path to CSV file
            
        Returns:
            List of HourlyConsumption records
        """
        parser = CSVConsumptionParser(file_path)
        records = parser.parse_all()
        
        results = []
        for record in records:
            try:
                consumption = self.process_record(record)
                results.append(consumption)
                logger.info(
                    f"Processed consumption for {record.consumer_id} "
                    f"hour {record.hour_id}: {record.energy_wh} Wh"
                )
            except Exception as e:
                logger.error(f"Failed to process record: {e}")
        
        return results
    
    def submit_consumption(
        self,
        consumption: HourlyConsumption,
        consumer_id_on_chain: str,
        signature: Optional[str] = None
    ) -> Optional[str]:
        """
        Submit consumption claim to ConsumptionOracle.
        
        Args:
            consumption: Processed consumption data
            consumer_id_on_chain: The consumerId registered on-chain (bytes32)
            signature: Optional pre-computed signature
            
        Returns:
            Transaction hash if successful, None otherwise
        """
        if not self.submitter:
            raise RuntimeError("Submitter not configured")
        
        # Store evidence first if store is configured
        if self.evidence_store:
            try:
                evidence = Evidence(
                    id=None,
                    evidence_root=consumption.evidence_root,
                    verifier_address=self.verifier_address,
                    system_id=consumption.consumer_id,  # Using consumer_id as system_id
                    hour_id=consumption.hour_id,
                    raw_response=consumption.raw_data,
                    canonical_json=consumption.canonical_json,
                    canonical_hash=consumption.canonical_hash,
                    signature=signature or ""
                )
                self.evidence_store.insert_evidence(evidence)
            except Exception as e:
                logger.warning(f"Failed to store evidence: {e}")
        
        # Create claim data
        claim = ClaimData(
            subject_id=consumer_id_on_chain,
            hour_id=consumption.hour_id,
            energy_wh=consumption.energy_wh,
            evidence_root=consumption.evidence_root
        )
        
        # Submit to oracle
        result = self.submitter.submit_consumption(claim)
        
        if result.success:
            logger.info(
                f"Submitted consumption claim for hour {consumption.hour_id}, "
                f"tx: {result.tx_hash}"
            )
            
            # Update evidence store with submission
            if self.evidence_store:
                try:
                    claim_key = self.submitter.get_claim_key(
                        consumer_id_on_chain,
                        consumption.hour_id,
                        ClaimType.CONSUMPTION
                    )
                    submission = ClaimSubmission(
                        id=None,
                        claim_key=claim_key,
                        verifier_address=self.verifier_address,
                        energy_wh=consumption.energy_wh,
                        evidence_root=consumption.evidence_root,
                        tx_hash=result.tx_hash,
                        status="confirmed"
                    )
                    self.evidence_store.insert_claim_submission(submission)
                except Exception as e:
                    logger.warning(f"Failed to store submission: {e}")
            
            return result.tx_hash
        else:
            logger.error(f"Failed to submit consumption claim: {result.error}")
            return None
    
    def process_and_submit_csv(
        self,
        file_path: str,
        consumer_id_mapping: Dict[str, str]
    ) -> Dict[str, List[str]]:
        """
        Process CSV file and submit all consumption claims.
        
        Args:
            file_path: Path to CSV file
            consumer_id_mapping: Mapping from CSV consumer_id to on-chain consumerId
            
        Returns:
            Dict with 'success' and 'failed' lists of hour_ids
        """
        results = {
            'success': [],
            'failed': []
        }
        
        consumptions = self.process_csv(file_path)
        
        for consumption in consumptions:
            # Get on-chain consumer ID
            consumer_id_on_chain = consumer_id_mapping.get(consumption.consumer_id)
            if not consumer_id_on_chain:
                logger.warning(
                    f"No on-chain mapping for consumer {consumption.consumer_id}"
                )
                results['failed'].append(f"{consumption.consumer_id}:{consumption.hour_id}")
                continue
            
            try:
                tx_hash = self.submit_consumption(consumption, consumer_id_on_chain)
                if tx_hash:
                    results['success'].append(f"{consumption.consumer_id}:{consumption.hour_id}")
                else:
                    results['failed'].append(f"{consumption.consumer_id}:{consumption.hour_id}")
            except Exception as e:
                logger.error(f"Error submitting consumption: {e}")
                results['failed'].append(f"{consumption.consumer_id}:{consumption.hour_id}")
        
        return results


def aggregate_hourly(records: List[ConsumptionRecord]) -> Dict[tuple, int]:
    """
    Aggregate consumption records by (consumer_id, hour_id).
    
    Useful when CSV has sub-hourly data that needs aggregation.
    
    Args:
        records: List of consumption records
        
    Returns:
        Dict mapping (consumer_id, hour_id) to total energy_wh
    """
    aggregated: Dict[tuple, int] = {}
    
    for record in records:
        key = (record.consumer_id, record.hour_id)
        if key in aggregated:
            aggregated[key] += record.energy_wh
        else:
            aggregated[key] = record.energy_wh
    
    return aggregated


# Mock client for testing
class MockConsumptionClient(ConsumptionClient):
    """
    Mock consumption client for testing without real submissions.
    """
    
    def __init__(self, verifier_address: str):
        """Initialize mock client."""
        super().__init__(verifier_address, None, None)
        self.submitted_claims: List[HourlyConsumption] = []
    
    def submit_consumption(
        self,
        consumption: HourlyConsumption,
        consumer_id_on_chain: str,
        signature: Optional[str] = None
    ) -> Optional[str]:
        """Mock submission that just records the claim."""
        self.submitted_claims.append(consumption)
        # Return a fake tx hash
        fake_hash = keccak(
            f"{consumption.consumer_id}:{consumption.hour_id}".encode()
        ).hex()
        return '0x' + fake_hash
