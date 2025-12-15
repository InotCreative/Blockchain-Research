"""
Evidence Store for SEARChain Oracle Service.

This module handles PostgreSQL database operations for storing
evidence data and claim submissions.

Requirements: 9.5
"""

import os
import logging
from datetime import datetime, timezone
from typing import Dict, List, Optional, Any
from dataclasses import dataclass
from contextlib import contextmanager

import psycopg2
from psycopg2.extras import RealDictCursor, Json
from psycopg2.pool import ThreadedConnectionPool

# Configure logging
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)


@dataclass
class Evidence:
    """Evidence record from the database."""
    id: Optional[int]
    evidence_root: str
    verifier_address: str
    system_id: str
    hour_id: int
    raw_response: Dict[str, Any]
    canonical_json: str
    canonical_hash: str
    signature: str
    created_at: Optional[datetime] = None


@dataclass
class ClaimSubmission:
    """Claim submission record from the database."""
    id: Optional[int]
    claim_key: str
    verifier_address: str
    energy_wh: int
    evidence_root: str
    tx_hash: Optional[str] = None
    status: str = "pending"
    created_at: Optional[datetime] = None


class EvidenceStore:
    """
    PostgreSQL-backed evidence store.
    
    Handles storage and retrieval of:
    - Raw API responses and their canonical hashes
    - Claim submissions and their transaction status
    """
    
    # Default connection parameters
    DEFAULT_HOST = "localhost"
    DEFAULT_PORT = 5432
    DEFAULT_DATABASE = "searchain"
    DEFAULT_USER = "searchain"
    DEFAULT_PASSWORD = "searchain"
    
    # Connection pool settings
    MIN_CONNECTIONS = 1
    MAX_CONNECTIONS = 10
    
    def __init__(
        self,
        host: Optional[str] = None,
        port: Optional[int] = None,
        database: Optional[str] = None,
        user: Optional[str] = None,
        password: Optional[str] = None,
        connection_string: Optional[str] = None
    ):
        """
        Initialize evidence store.
        
        Args:
            host: PostgreSQL host
            port: PostgreSQL port
            database: Database name
            user: Database user
            password: Database password
            connection_string: Full connection string (overrides other params)
        """
        if connection_string:
            self.connection_string = connection_string
        else:
            self.connection_string = self._build_connection_string(
                host or os.getenv("DB_HOST", self.DEFAULT_HOST),
                port or int(os.getenv("DB_PORT", self.DEFAULT_PORT)),
                database or os.getenv("DB_NAME", self.DEFAULT_DATABASE),
                user or os.getenv("DB_USER", self.DEFAULT_USER),
                password or os.getenv("DB_PASSWORD", self.DEFAULT_PASSWORD)
            )
        
        self._pool: Optional[ThreadedConnectionPool] = None
    
    def _build_connection_string(
        self,
        host: str,
        port: int,
        database: str,
        user: str,
        password: str
    ) -> str:
        """Build PostgreSQL connection string."""
        return f"postgresql://{user}:{password}@{host}:{port}/{database}"
    
    def connect(self) -> None:
        """Initialize connection pool."""
        try:
            self._pool = ThreadedConnectionPool(
                self.MIN_CONNECTIONS,
                self.MAX_CONNECTIONS,
                self.connection_string
            )
            logger.info("Database connection pool initialized")
        except psycopg2.Error as e:
            logger.error(f"Failed to initialize connection pool: {e}")
            raise
    
    def close(self) -> None:
        """Close connection pool."""
        if self._pool:
            self._pool.closeall()
            self._pool = None
            logger.info("Database connection pool closed")
    
    @contextmanager
    def get_connection(self):
        """Get a connection from the pool."""
        if not self._pool:
            raise RuntimeError("Connection pool not initialized. Call connect() first.")
        
        conn = self._pool.getconn()
        try:
            yield conn
            conn.commit()
        except Exception:
            conn.rollback()
            raise
        finally:
            self._pool.putconn(conn)
    
    def initialize_schema(self) -> None:
        """Create database tables if they don't exist."""
        schema_sql = """
        -- Evidence table for raw API responses
        CREATE TABLE IF NOT EXISTS evidence (
            id SERIAL PRIMARY KEY,
            evidence_root VARCHAR(66) NOT NULL UNIQUE,
            verifier_address VARCHAR(42) NOT NULL,
            system_id VARCHAR(64) NOT NULL,
            hour_id BIGINT NOT NULL,
            raw_response JSONB NOT NULL,
            canonical_json TEXT NOT NULL,
            canonical_hash VARCHAR(66) NOT NULL,
            signature VARCHAR(132) NOT NULL,
            created_at TIMESTAMP DEFAULT NOW(),
            UNIQUE(verifier_address, system_id, hour_id)
        );
        
        -- Claim submissions table
        CREATE TABLE IF NOT EXISTS claim_submissions (
            id SERIAL PRIMARY KEY,
            claim_key VARCHAR(66) NOT NULL,
            verifier_address VARCHAR(42) NOT NULL,
            energy_wh BIGINT NOT NULL,
            evidence_root VARCHAR(66) NOT NULL,
            tx_hash VARCHAR(66),
            status VARCHAR(20) DEFAULT 'pending',
            created_at TIMESTAMP DEFAULT NOW(),
            FOREIGN KEY (evidence_root) REFERENCES evidence(evidence_root)
        );
        
        -- Indexes for efficient lookups
        CREATE INDEX IF NOT EXISTS idx_evidence_hour ON evidence(hour_id);
        CREATE INDEX IF NOT EXISTS idx_evidence_system ON evidence(system_id);
        CREATE INDEX IF NOT EXISTS idx_evidence_verifier ON evidence(verifier_address);
        CREATE INDEX IF NOT EXISTS idx_submissions_claim ON claim_submissions(claim_key);
        CREATE INDEX IF NOT EXISTS idx_submissions_status ON claim_submissions(status);
        """
        
        with self.get_connection() as conn:
            with conn.cursor() as cur:
                cur.execute(schema_sql)
        
        logger.info("Database schema initialized")


    # ============ Evidence Operations ============
    
    def insert_evidence(self, evidence: Evidence) -> int:
        """
        Insert evidence record.
        
        Args:
            evidence: Evidence record to insert
            
        Returns:
            ID of inserted record
            
        Raises:
            psycopg2.IntegrityError: If evidence_root already exists
        """
        sql = """
        INSERT INTO evidence (
            evidence_root, verifier_address, system_id, hour_id,
            raw_response, canonical_json, canonical_hash, signature
        ) VALUES (
            %(evidence_root)s, %(verifier_address)s, %(system_id)s, %(hour_id)s,
            %(raw_response)s, %(canonical_json)s, %(canonical_hash)s, %(signature)s
        )
        RETURNING id
        """
        
        with self.get_connection() as conn:
            with conn.cursor() as cur:
                cur.execute(sql, {
                    "evidence_root": evidence.evidence_root,
                    "verifier_address": evidence.verifier_address.lower(),
                    "system_id": evidence.system_id,
                    "hour_id": evidence.hour_id,
                    "raw_response": Json(evidence.raw_response),
                    "canonical_json": evidence.canonical_json,
                    "canonical_hash": evidence.canonical_hash,
                    "signature": evidence.signature
                })
                result = cur.fetchone()
                return result[0]
    
    def get_evidence_by_root(self, evidence_root: str) -> Optional[Evidence]:
        """
        Get evidence by evidence root.
        
        Args:
            evidence_root: Evidence root hash
            
        Returns:
            Evidence record or None if not found
        """
        sql = """
        SELECT id, evidence_root, verifier_address, system_id, hour_id,
               raw_response, canonical_json, canonical_hash, signature, created_at
        FROM evidence
        WHERE evidence_root = %s
        """
        
        with self.get_connection() as conn:
            with conn.cursor(cursor_factory=RealDictCursor) as cur:
                cur.execute(sql, (evidence_root,))
                row = cur.fetchone()
                if row:
                    return Evidence(**row)
                return None
    
    def get_evidence_by_hour(
        self,
        hour_id: int,
        verifier_address: Optional[str] = None
    ) -> List[Evidence]:
        """
        Get all evidence for a specific hour.
        
        Args:
            hour_id: Hour identifier
            verifier_address: Optional filter by verifier
            
        Returns:
            List of Evidence records
        """
        if verifier_address:
            sql = """
            SELECT id, evidence_root, verifier_address, system_id, hour_id,
                   raw_response, canonical_json, canonical_hash, signature, created_at
            FROM evidence
            WHERE hour_id = %s AND verifier_address = %s
            ORDER BY created_at
            """
            params = (hour_id, verifier_address.lower())
        else:
            sql = """
            SELECT id, evidence_root, verifier_address, system_id, hour_id,
                   raw_response, canonical_json, canonical_hash, signature, created_at
            FROM evidence
            WHERE hour_id = %s
            ORDER BY created_at
            """
            params = (hour_id,)
        
        with self.get_connection() as conn:
            with conn.cursor(cursor_factory=RealDictCursor) as cur:
                cur.execute(sql, params)
                rows = cur.fetchall()
                return [Evidence(**row) for row in rows]
    
    def get_evidence_by_system(
        self,
        system_id: str,
        start_hour: Optional[int] = None,
        end_hour: Optional[int] = None
    ) -> List[Evidence]:
        """
        Get evidence for a specific system.
        
        Args:
            system_id: System identifier
            start_hour: Optional start hour filter
            end_hour: Optional end hour filter
            
        Returns:
            List of Evidence records
        """
        conditions = ["system_id = %s"]
        params = [system_id]
        
        if start_hour is not None:
            conditions.append("hour_id >= %s")
            params.append(start_hour)
        
        if end_hour is not None:
            conditions.append("hour_id <= %s")
            params.append(end_hour)
        
        sql = f"""
        SELECT id, evidence_root, verifier_address, system_id, hour_id,
               raw_response, canonical_json, canonical_hash, signature, created_at
        FROM evidence
        WHERE {' AND '.join(conditions)}
        ORDER BY hour_id, created_at
        """
        
        with self.get_connection() as conn:
            with conn.cursor(cursor_factory=RealDictCursor) as cur:
                cur.execute(sql, params)
                rows = cur.fetchall()
                return [Evidence(**row) for row in rows]
    
    def evidence_exists(
        self,
        verifier_address: str,
        system_id: str,
        hour_id: int
    ) -> bool:
        """
        Check if evidence already exists for a verifier/system/hour combination.
        
        Args:
            verifier_address: Verifier's address
            system_id: System identifier
            hour_id: Hour identifier
            
        Returns:
            True if evidence exists
        """
        sql = """
        SELECT 1 FROM evidence
        WHERE verifier_address = %s AND system_id = %s AND hour_id = %s
        LIMIT 1
        """
        
        with self.get_connection() as conn:
            with conn.cursor() as cur:
                cur.execute(sql, (verifier_address.lower(), system_id, hour_id))
                return cur.fetchone() is not None
    
    # ============ Claim Submission Operations ============
    
    def insert_claim_submission(self, submission: ClaimSubmission) -> int:
        """
        Insert claim submission record.
        
        Args:
            submission: ClaimSubmission record to insert
            
        Returns:
            ID of inserted record
        """
        sql = """
        INSERT INTO claim_submissions (
            claim_key, verifier_address, energy_wh, evidence_root, tx_hash, status
        ) VALUES (
            %(claim_key)s, %(verifier_address)s, %(energy_wh)s,
            %(evidence_root)s, %(tx_hash)s, %(status)s
        )
        RETURNING id
        """
        
        with self.get_connection() as conn:
            with conn.cursor() as cur:
                cur.execute(sql, {
                    "claim_key": submission.claim_key,
                    "verifier_address": submission.verifier_address.lower(),
                    "energy_wh": submission.energy_wh,
                    "evidence_root": submission.evidence_root,
                    "tx_hash": submission.tx_hash,
                    "status": submission.status
                })
                result = cur.fetchone()
                return result[0]
    
    def update_submission_status(
        self,
        submission_id: int,
        status: str,
        tx_hash: Optional[str] = None
    ) -> None:
        """
        Update claim submission status.
        
        Args:
            submission_id: Submission ID
            status: New status (pending, submitted, confirmed, failed)
            tx_hash: Optional transaction hash
        """
        if tx_hash:
            sql = """
            UPDATE claim_submissions
            SET status = %s, tx_hash = %s
            WHERE id = %s
            """
            params = (status, tx_hash, submission_id)
        else:
            sql = """
            UPDATE claim_submissions
            SET status = %s
            WHERE id = %s
            """
            params = (status, submission_id)
        
        with self.get_connection() as conn:
            with conn.cursor() as cur:
                cur.execute(sql, params)
    
    def get_submission_by_id(self, submission_id: int) -> Optional[ClaimSubmission]:
        """
        Get claim submission by ID.
        
        Args:
            submission_id: Submission ID
            
        Returns:
            ClaimSubmission record or None
        """
        sql = """
        SELECT id, claim_key, verifier_address, energy_wh, evidence_root,
               tx_hash, status, created_at
        FROM claim_submissions
        WHERE id = %s
        """
        
        with self.get_connection() as conn:
            with conn.cursor(cursor_factory=RealDictCursor) as cur:
                cur.execute(sql, (submission_id,))
                row = cur.fetchone()
                if row:
                    return ClaimSubmission(**row)
                return None
    
    def get_submissions_by_claim(self, claim_key: str) -> List[ClaimSubmission]:
        """
        Get all submissions for a claim key.
        
        Args:
            claim_key: Claim key
            
        Returns:
            List of ClaimSubmission records
        """
        sql = """
        SELECT id, claim_key, verifier_address, energy_wh, evidence_root,
               tx_hash, status, created_at
        FROM claim_submissions
        WHERE claim_key = %s
        ORDER BY created_at
        """
        
        with self.get_connection() as conn:
            with conn.cursor(cursor_factory=RealDictCursor) as cur:
                cur.execute(sql, (claim_key,))
                rows = cur.fetchall()
                return [ClaimSubmission(**row) for row in rows]
    
    def get_pending_submissions(self) -> List[ClaimSubmission]:
        """
        Get all pending submissions.
        
        Returns:
            List of pending ClaimSubmission records
        """
        sql = """
        SELECT id, claim_key, verifier_address, energy_wh, evidence_root,
               tx_hash, status, created_at
        FROM claim_submissions
        WHERE status = 'pending'
        ORDER BY created_at
        """
        
        with self.get_connection() as conn:
            with conn.cursor(cursor_factory=RealDictCursor) as cur:
                cur.execute(sql)
                rows = cur.fetchall()
                return [ClaimSubmission(**row) for row in rows]
    
    def submission_exists(
        self,
        claim_key: str,
        verifier_address: str
    ) -> bool:
        """
        Check if a submission already exists for a claim/verifier combination.
        
        Args:
            claim_key: Claim key
            verifier_address: Verifier's address
            
        Returns:
            True if submission exists
        """
        sql = """
        SELECT 1 FROM claim_submissions
        WHERE claim_key = %s AND verifier_address = %s
        LIMIT 1
        """
        
        with self.get_connection() as conn:
            with conn.cursor() as cur:
                cur.execute(sql, (claim_key, verifier_address.lower()))
                return cur.fetchone() is not None


# In-memory store for testing without PostgreSQL
class InMemoryEvidenceStore:
    """
    In-memory evidence store for testing.
    
    Provides the same interface as EvidenceStore but stores data in memory.
    """
    
    def __init__(self):
        """Initialize in-memory store."""
        self._evidence: Dict[str, Evidence] = {}  # keyed by evidence_root
        self._submissions: Dict[int, ClaimSubmission] = {}
        self._next_evidence_id = 1
        self._next_submission_id = 1
    
    def connect(self) -> None:
        """No-op for in-memory store."""
        pass
    
    def close(self) -> None:
        """No-op for in-memory store."""
        pass
    
    def initialize_schema(self) -> None:
        """No-op for in-memory store."""
        pass
    
    def insert_evidence(self, evidence: Evidence) -> int:
        """Insert evidence record."""
        if evidence.evidence_root in self._evidence:
            raise ValueError(f"Evidence root already exists: {evidence.evidence_root}")
        
        evidence.id = self._next_evidence_id
        evidence.created_at = datetime.now(timezone.utc)
        self._evidence[evidence.evidence_root] = evidence
        self._next_evidence_id += 1
        return evidence.id
    
    def get_evidence_by_root(self, evidence_root: str) -> Optional[Evidence]:
        """Get evidence by root."""
        return self._evidence.get(evidence_root)
    
    def get_evidence_by_hour(
        self,
        hour_id: int,
        verifier_address: Optional[str] = None
    ) -> List[Evidence]:
        """Get evidence by hour."""
        results = []
        for ev in self._evidence.values():
            if ev.hour_id == hour_id:
                if verifier_address is None or ev.verifier_address.lower() == verifier_address.lower():
                    results.append(ev)
        return sorted(results, key=lambda x: x.created_at or datetime.min)
    
    def get_evidence_by_system(
        self,
        system_id: str,
        start_hour: Optional[int] = None,
        end_hour: Optional[int] = None
    ) -> List[Evidence]:
        """Get evidence by system."""
        results = []
        for ev in self._evidence.values():
            if ev.system_id == system_id:
                if start_hour is not None and ev.hour_id < start_hour:
                    continue
                if end_hour is not None and ev.hour_id > end_hour:
                    continue
                results.append(ev)
        return sorted(results, key=lambda x: (x.hour_id, x.created_at or datetime.min))
    
    def evidence_exists(
        self,
        verifier_address: str,
        system_id: str,
        hour_id: int
    ) -> bool:
        """Check if evidence exists."""
        for ev in self._evidence.values():
            if (ev.verifier_address.lower() == verifier_address.lower() and
                ev.system_id == system_id and
                ev.hour_id == hour_id):
                return True
        return False
    
    def insert_claim_submission(self, submission: ClaimSubmission) -> int:
        """Insert claim submission."""
        submission.id = self._next_submission_id
        submission.created_at = datetime.now(timezone.utc)
        self._submissions[submission.id] = submission
        self._next_submission_id += 1
        return submission.id
    
    def update_submission_status(
        self,
        submission_id: int,
        status: str,
        tx_hash: Optional[str] = None
    ) -> None:
        """Update submission status."""
        if submission_id in self._submissions:
            self._submissions[submission_id].status = status
            if tx_hash:
                self._submissions[submission_id].tx_hash = tx_hash
    
    def get_submission_by_id(self, submission_id: int) -> Optional[ClaimSubmission]:
        """Get submission by ID."""
        return self._submissions.get(submission_id)
    
    def get_submissions_by_claim(self, claim_key: str) -> List[ClaimSubmission]:
        """Get submissions by claim key."""
        results = [s for s in self._submissions.values() if s.claim_key == claim_key]
        return sorted(results, key=lambda x: x.created_at or datetime.min)
    
    def get_pending_submissions(self) -> List[ClaimSubmission]:
        """Get pending submissions."""
        results = [s for s in self._submissions.values() if s.status == "pending"]
        return sorted(results, key=lambda x: x.created_at or datetime.min)
    
    def submission_exists(self, claim_key: str, verifier_address: str) -> bool:
        """Check if submission exists."""
        for s in self._submissions.values():
            if (s.claim_key == claim_key and
                s.verifier_address.lower() == verifier_address.lower()):
                return True
        return False
