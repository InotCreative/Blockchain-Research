// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * @title MockConsumptionOracle
 * @dev Mock contract for testing Matcher functionality
 */
contract MockConsumptionOracle {
    /// @notice Mapping of consumerId => hourId => verified consumption
    mapping(bytes32 => mapping(uint256 => uint64)) private _verifiedConsumption;

    /**
     * @notice Set verified consumption for testing
     * @param consumerId The consumer identifier
     * @param hourId The hour identifier
     * @param energyWh The verified consumption in Wh
     */
    function setVerifiedConsumption(bytes32 consumerId, uint256 hourId, uint64 energyWh) external {
        _verifiedConsumption[consumerId][hourId] = energyWh;
    }

    /**
     * @notice Get verified consumption for a consumer and hour
     * @param consumerId The consumer identifier
     * @param hourId The hour identifier
     * @return The verified consumption in Wh (0 if not verified)
     */
    function getVerifiedConsumption(bytes32 consumerId, uint256 hourId) external view returns (uint64) {
        return _verifiedConsumption[consumerId][hourId];
    }
}
