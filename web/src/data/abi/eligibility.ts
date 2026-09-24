// HAND-WRITTEN from docs/specs/W3W4-contracts.md — provisional until web/scripts/sync-abi.mjs
// regenerates it from forge out/. EligibilityRegistry (IEligibility + admin), from the spec.
// Source signatures:
//   function isEligible(address who) view returns (bool)
//   function setEligible(address who, bool ok, bytes32 evidence)
//   event EligibilitySet(address indexed who, bool ok, bytes32 evidence)
//   error NotAdmin()
//   error NotPendingAdmin()
//   error ZeroAddress()
export const eligibilityAbi = [
  {
    "name": "isEligible",
    "type": "function",
    "stateMutability": "view",
    "inputs": [
      {
        "type": "address",
        "name": "who"
      }
    ],
    "outputs": [
      {
        "type": "bool"
      }
    ]
  },
  {
    "name": "setEligible",
    "type": "function",
    "stateMutability": "nonpayable",
    "inputs": [
      {
        "type": "address",
        "name": "who"
      },
      {
        "type": "bool",
        "name": "ok"
      },
      {
        "type": "bytes32",
        "name": "evidence"
      }
    ],
    "outputs": []
  },
  {
    "name": "EligibilitySet",
    "type": "event",
    "inputs": [
      {
        "type": "address",
        "name": "who",
        "indexed": true
      },
      {
        "type": "bool",
        "name": "ok"
      },
      {
        "type": "bytes32",
        "name": "evidence"
      }
    ]
  },
  {
    "name": "NotAdmin",
    "type": "error",
    "inputs": []
  },
  {
    "name": "NotPendingAdmin",
    "type": "error",
    "inputs": []
  },
  {
    "name": "ZeroAddress",
    "type": "error",
    "inputs": []
  }
] as const;
