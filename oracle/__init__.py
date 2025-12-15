"""
SEARChain Oracle Service Package.

This package provides the off-chain oracle service components for
verifying energy production and consumption data.

Components:
- enphase_client: Enphase API polling and data processing
- evidence_store: PostgreSQL-backed evidence storage
- submitter: Claim signing and submission to Oracle contracts
- consumption_client: CSV consumption data processing
"""

from .enphase_client import (
    EnphaseClient,
    MockEnphaseClient,
    HourlyProduction,
    RFC8785Canonicalizer,
    get_current_hour_id,
    get_previous_hour_id,
)

from .evidence_store import (
    EvidenceStore,
    InMemoryEvidenceStore,
    Evidence,
    ClaimSubmission,
)

from .submitter import (
    ClaimSigner,
    ClaimSubmitter,
    ClaimData,
    ClaimType,
    SubmissionResult,
    create_submitter_from_env,
)

from .consumption_client import (
    ConsumptionClient,
    MockConsumptionClient,
    CSVConsumptionParser,
    ConsumptionRecord,
    HourlyConsumption,
    aggregate_hourly,
)

__all__ = [
    # Enphase client
    'EnphaseClient',
    'MockEnphaseClient',
    'HourlyProduction',
    'RFC8785Canonicalizer',
    'get_current_hour_id',
    'get_previous_hour_id',
    # Evidence store
    'EvidenceStore',
    'InMemoryEvidenceStore',
    'Evidence',
    'ClaimSubmission',
    # Submitter
    'ClaimSigner',
    'ClaimSubmitter',
    'ClaimData',
    'ClaimType',
    'SubmissionResult',
    'create_submitter_from_env',
    # Consumption client
    'ConsumptionClient',
    'MockConsumptionClient',
    'CSVConsumptionParser',
    'ConsumptionRecord',
    'HourlyConsumption',
    'aggregate_hourly',
]
