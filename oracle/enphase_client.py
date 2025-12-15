"""
Enphase API Client for SEARChain Oracle Service.

This module handles polling the Enphase API for solar production data,
canonicalizing responses using RFC 8785, and computing evidence roots.

Requirements: 9.1, 9.2, 9.6, 9.7, 9.8
"""

import json
import hashlib
import time
import logging
from datetime import datetime, timezone
from typing import Dict, List, Optional, Any, Tuple
from dataclasses import dataclass
import requests
from requests.adapters import HTTPAdapter
from urllib3.util.retry import Retry

# Configure logging
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)


@dataclass
class HourlyProduction:
    """Represents hourly production data for a system."""
    system_id: str
    hour_id: int  # floor(unix_timestamp / 3600)
    energy_wh: int
    raw_response: Dict[str, Any]
    canonical_json: str
    canonical_hash: str
    evidence_root: str


class RFC8785Canonicalizer:
    """
    JSON Canonicalization Scheme (JCS) per RFC 8785.
    
    Ensures deterministic JSON serialization for consistent hashing across verifiers.
    Key rules:
    - Object keys sorted lexicographically
    - No whitespace
    - Numbers in shortest form without trailing zeros
    - Unicode escaping for control characters
    """
    
    @staticmethod
    def canonicalize(obj: Any) -> str:
        """
        Canonicalize a Python object to RFC 8785 compliant JSON string.
        
        Args:
            obj: Python object to canonicalize
            
        Returns:
            Canonical JSON string
        """
        return json.dumps(
            obj,
            separators=(',', ':'),
            sort_keys=True,
            ensure_ascii=False
        )
    
    @staticmethod
    def compute_hash(canonical_json: str) -> str:
        """
        Compute keccak256 hash of canonical JSON.
        
        Args:
            canonical_json: RFC 8785 canonical JSON string
            
        Returns:
            Hex string of keccak256 hash (with 0x prefix)
        """
        from eth_hash.auto import keccak
        hash_bytes = keccak(canonical_json.encode('utf-8'))
        return '0x' + hash_bytes.hex()


class EnphaseClient:
    """
    Client for polling Enphase API with rate limiting.
    
    Handles:
    - API authentication and polling
    - Rate limiting (respects Enphase API limits)
    - Sub-hourly data aggregation to hourly totals
    - RFC 8785 canonicalization
    - Evidence root computation
    """
    
    # Enphase API rate limits
    DEFAULT_RATE_LIMIT_REQUESTS = 10  # requests per minute
    DEFAULT_RATE_LIMIT_WINDOW = 60  # seconds
    
    def __init__(
        self,
        api_key: str,
        access_token: str,
        verifier_address: str,
        base_url: str = "https://api.enphaseenergy.com/api/v4",
        rate_limit_requests: int = DEFAULT_RATE_LIMIT_REQUESTS,
        rate_limit_window: int = DEFAULT_RATE_LIMIT_WINDOW,
        max_retries: int = 3
    ):
        """
        Initialize Enphase client.
        
        Args:
            api_key: Enphase API key
            access_token: OAuth access token
            verifier_address: Ethereum address of the verifier (for evidence root)
            base_url: Enphase API base URL
            rate_limit_requests: Max requests per rate limit window
            rate_limit_window: Rate limit window in seconds
            max_retries: Maximum retry attempts for failed requests
        """
        self.api_key = api_key
        self.access_token = access_token
        self.verifier_address = verifier_address.lower()
        self.base_url = base_url
        self.rate_limit_requests = rate_limit_requests
        self.rate_limit_window = rate_limit_window
        self.max_retries = max_retries
        
        # Rate limiting state
        self._request_timestamps: List[float] = []
        
        # Setup session with retry logic
        self.session = self._create_session()
        
        # Canonicalizer
        self.canonicalizer = RFC8785Canonicalizer()
    
    def _create_session(self) -> requests.Session:
        """Create requests session with retry configuration."""
        session = requests.Session()
        
        retry_strategy = Retry(
            total=self.max_retries,
            backoff_factor=1,
            status_forcelist=[429, 500, 502, 503, 504],
            allowed_methods=["GET", "POST"]
        )
        
        adapter = HTTPAdapter(max_retries=retry_strategy)
        session.mount("https://", adapter)
        session.mount("http://", adapter)
        
        return session
    
    def _wait_for_rate_limit(self) -> None:
        """Wait if necessary to respect rate limits."""
        now = time.time()
        
        # Remove timestamps outside the window
        self._request_timestamps = [
            ts for ts in self._request_timestamps
            if now - ts < self.rate_limit_window
        ]
        
        # If at limit, wait until oldest request expires
        if len(self._request_timestamps) >= self.rate_limit_requests:
            oldest = min(self._request_timestamps)
            wait_time = self.rate_limit_window - (now - oldest) + 0.1
            if wait_time > 0:
                logger.info(f"Rate limit reached, waiting {wait_time:.1f}s")
                time.sleep(wait_time)
    
    def _make_request(self, endpoint: str, params: Optional[Dict] = None) -> Dict[str, Any]:
        """
        Make an API request with rate limiting.
        
        Args:
            endpoint: API endpoint path
            params: Query parameters
            
        Returns:
            JSON response as dict
            
        Raises:
            requests.RequestException: On API errors
        """
        self._wait_for_rate_limit()
        
        url = f"{self.base_url}/{endpoint}"
        headers = {
            "Authorization": f"Bearer {self.access_token}",
            "key": self.api_key
        }
        
        try:
            response = self.session.get(url, headers=headers, params=params, timeout=30)
            response.raise_for_status()
            
            self._request_timestamps.append(time.time())
            return response.json()
            
        except requests.RequestException as e:
            logger.error(f"API request failed: {e}")
            raise


    def get_system_production(
        self,
        system_id: str,
        start_at: int,
        end_at: Optional[int] = None
    ) -> Dict[str, Any]:
        """
        Get production data for a system.
        
        Args:
            system_id: Enphase system ID
            start_at: Start timestamp (Unix epoch)
            end_at: End timestamp (Unix epoch), defaults to start_at + 3600
            
        Returns:
            Raw API response
        """
        if end_at is None:
            end_at = start_at + 3600
        
        params = {
            "start_at": start_at,
            "end_at": end_at,
            "granularity": "day"  # We'll aggregate sub-hourly data
        }
        
        return self._make_request(f"systems/{system_id}/telemetry/production_micro", params)
    
    def get_hourly_production(
        self,
        system_id: str,
        hour_id: int
    ) -> HourlyProduction:
        """
        Get and process hourly production data.
        
        Args:
            system_id: Enphase system ID
            hour_id: Hour identifier (floor(unix_timestamp / 3600))
            
        Returns:
            HourlyProduction with canonicalized data and evidence root
        """
        # Calculate timestamps for the hour
        start_at = hour_id * 3600
        end_at = start_at + 3600
        
        # Fetch raw data
        raw_response = self.get_system_production(system_id, start_at, end_at)
        
        # Aggregate sub-hourly data to hourly total
        energy_wh = self._aggregate_to_hourly(raw_response, start_at, end_at)
        
        # Canonicalize response
        canonical_json = self.canonicalizer.canonicalize(raw_response)
        canonical_hash = self.canonicalizer.compute_hash(canonical_json)
        
        # Compute evidence root
        system_id_hash = self._compute_system_id_hash(system_id)
        evidence_root = self._compute_evidence_root(
            system_id_hash,
            hour_id,
            canonical_hash,
            self.verifier_address
        )
        
        return HourlyProduction(
            system_id=system_id,
            hour_id=hour_id,
            energy_wh=energy_wh,
            raw_response=raw_response,
            canonical_json=canonical_json,
            canonical_hash=canonical_hash,
            evidence_root=evidence_root
        )
    
    def _aggregate_to_hourly(
        self,
        response: Dict[str, Any],
        start_at: int,
        end_at: int
    ) -> int:
        """
        Aggregate sub-hourly data to hourly total.
        
        Uses deterministic formula: sum of all intervals within the hour.
        
        Args:
            response: Raw API response
            start_at: Hour start timestamp
            end_at: Hour end timestamp
            
        Returns:
            Total energy in Wh for the hour
        """
        total_wh = 0
        
        # Handle different response formats
        intervals = response.get("intervals", [])
        
        for interval in intervals:
            # Get interval timestamp
            interval_end = interval.get("end_at", 0)
            
            # Only include intervals within our hour
            if start_at <= interval_end <= end_at:
                # Enphase reports in Wh
                wh = interval.get("enwh", 0)
                if wh is None:
                    wh = 0
                total_wh += int(wh)
        
        return total_wh
    
    def _compute_system_id_hash(self, system_id: str) -> str:
        """
        Compute keccak256 hash of system ID.
        
        Args:
            system_id: Enphase system ID
            
        Returns:
            Hex string of hash (with 0x prefix)
        """
        from eth_hash.auto import keccak
        hash_bytes = keccak(system_id.encode('utf-8'))
        return '0x' + hash_bytes.hex()
    
    def _compute_evidence_root(
        self,
        system_id_hash: str,
        hour_id: int,
        canonical_hash: str,
        verifier_address: str
    ) -> str:
        """
        Compute evidence root for a single-leaf evidence package.
        
        evidenceRoot = keccak256(abi.encodePacked(
            systemIdHash,
            hourId,
            canonicalHash,
            verifierAddress
        ))
        
        Args:
            system_id_hash: Hash of system ID
            hour_id: Hour identifier
            canonical_hash: Hash of canonical JSON
            verifier_address: Verifier's Ethereum address
            
        Returns:
            Evidence root as hex string (with 0x prefix)
        """
        from eth_abi import encode
        from eth_hash.auto import keccak
        
        # Remove 0x prefix for encoding
        system_id_bytes = bytes.fromhex(system_id_hash[2:])
        canonical_bytes = bytes.fromhex(canonical_hash[2:])
        verifier_bytes = bytes.fromhex(verifier_address[2:])
        
        # Pack the data (similar to abi.encodePacked)
        packed = (
            system_id_bytes +
            hour_id.to_bytes(32, 'big') +
            canonical_bytes +
            verifier_bytes
        )
        
        hash_bytes = keccak(packed)
        return '0x' + hash_bytes.hex()
    
    def poll_systems(
        self,
        system_ids: List[str],
        hour_id: int
    ) -> List[HourlyProduction]:
        """
        Poll multiple systems for a specific hour.
        
        Args:
            system_ids: List of Enphase system IDs
            hour_id: Hour identifier
            
        Returns:
            List of HourlyProduction results
        """
        results = []
        
        for system_id in system_ids:
            try:
                production = self.get_hourly_production(system_id, hour_id)
                results.append(production)
                logger.info(
                    f"Polled system {system_id} for hour {hour_id}: "
                    f"{production.energy_wh} Wh"
                )
            except Exception as e:
                logger.error(f"Failed to poll system {system_id}: {e}")
                # Continue with other systems
        
        return results


def get_current_hour_id() -> int:
    """Get the current hour ID (floor(unix_timestamp / 3600))."""
    return int(time.time()) // 3600


def get_previous_hour_id() -> int:
    """Get the previous hour ID (for processing completed hours)."""
    return get_current_hour_id() - 1


# Mock client for testing without real API access
class MockEnphaseClient(EnphaseClient):
    """
    Mock Enphase client for testing.
    
    Returns simulated production data without making real API calls.
    """
    
    def __init__(self, verifier_address: str, mock_data: Optional[Dict] = None):
        """
        Initialize mock client.
        
        Args:
            verifier_address: Verifier's Ethereum address
            mock_data: Optional dict mapping (system_id, hour_id) to energy_wh
        """
        self.verifier_address = verifier_address.lower()
        self.mock_data = mock_data or {}
        self.canonicalizer = RFC8785Canonicalizer()
        self._request_timestamps = []
    
    def get_hourly_production(
        self,
        system_id: str,
        hour_id: int
    ) -> HourlyProduction:
        """Return mock production data."""
        # Get mock energy or generate random
        key = (system_id, hour_id)
        if key in self.mock_data:
            energy_wh = self.mock_data[key]
        else:
            # Generate deterministic mock data based on system_id and hour_id
            import hashlib
            seed = hashlib.sha256(f"{system_id}:{hour_id}".encode()).digest()
            energy_wh = int.from_bytes(seed[:4], 'big') % 10000  # 0-10000 Wh
        
        # Create mock raw response
        raw_response = {
            "system_id": system_id,
            "granularity": "day",
            "start_at": hour_id * 3600,
            "end_at": (hour_id + 1) * 3600,
            "intervals": [
                {
                    "end_at": hour_id * 3600 + 3600,
                    "enwh": energy_wh
                }
            ]
        }
        
        # Canonicalize
        canonical_json = self.canonicalizer.canonicalize(raw_response)
        canonical_hash = self.canonicalizer.compute_hash(canonical_json)
        
        # Compute evidence root
        system_id_hash = self._compute_system_id_hash(system_id)
        evidence_root = self._compute_evidence_root(
            system_id_hash,
            hour_id,
            canonical_hash,
            self.verifier_address
        )
        
        return HourlyProduction(
            system_id=system_id,
            hour_id=hour_id,
            energy_wh=energy_wh,
            raw_response=raw_response,
            canonical_json=canonical_json,
            canonical_hash=canonical_hash,
            evidence_root=evidence_root
        )
