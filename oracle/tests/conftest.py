"""
Pytest configuration and fixtures for oracle service tests.
"""

import pytest
import sys
import os

# Add parent directory to path for imports
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.dirname(__file__))))


@pytest.fixture
def verifier_address():
    """Standard test verifier address."""
    return "0x1234567890123456789012345678901234567890"


@pytest.fixture
def sample_producer_id():
    """Standard test producer ID."""
    return "0x" + "ab" * 32


@pytest.fixture
def sample_consumer_id():
    """Standard test consumer ID."""
    return "0x" + "cd" * 32


@pytest.fixture
def sample_hour_id():
    """Standard test hour ID."""
    return 500000


@pytest.fixture
def sample_evidence_root():
    """Standard test evidence root."""
    return "0x" + "ef" * 32
