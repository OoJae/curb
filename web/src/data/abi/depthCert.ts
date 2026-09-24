// HAND-WRITTEN from docs/specs/W3W4-contracts.md — provisional until web/scripts/sync-abi.mjs
// regenerates it from forge out/. IDepthCert, frozen in the spec (types exact). committed/claimableShares getters and event field types are provisional.
// Source signatures:
//   struct Cert { address maker; address wrapper; address beneficiary; uint128 sizeShares; uint128 remainingShares; uint128 bidPx; uint128 bond; uint64 postedAt; uint64 expiry; uint8 status; }
//   function post(address wrapper, address beneficiary, uint128 sizeShares, uint128 bidPx, uint64 expiry, uint128 bond) returns (uint256 id)
//   function take(uint256 id, uint128 shares, address to) returns (bool filled, uint256 amount)
//   function withdraw(uint256 id)
//   function claimShares(address wrapper, address to) returns (uint256)
//   function prune(address wrapper, address beneficiary)
//   function certOf(uint256 id) view returns (Cert)
//   function isHonourable(address maker) view returns (bool)
//   function honouredDepth(address wrapper, address beneficiary, uint64 minExpiry) view returns (uint256 shares, uint256 notional, uint128 minBidPx, uint64 soonestExpiry)
//   function committed(address maker) view returns (uint256)
//   function claimableShares(address maker, address wrapper) view returns (uint256)
//   function certCount() view returns (uint256)
//   event Posted(uint256 indexed id, address indexed maker, address indexed wrapper, address beneficiary, uint128 size, uint128 bidPx, uint128 bond, uint64 expiry)
//   event Filled(uint256 indexed id, address indexed taker, uint128 shares, uint256 paid, uint128 remaining)
//   event Faded(uint256 indexed id, address indexed taker, address indexed maker, uint128 shares, uint256 costOwed, uint128 bondSlashed, bytes4 reason)
//   event Withdrawn(uint256 indexed id, address indexed maker, uint128 bond)
//   event SharesClaimed(address indexed maker, address indexed wrapper, uint256 shares)
export const depthCertAbi = [
  {
    "name": "post",
    "type": "function",
    "stateMutability": "nonpayable",
    "inputs": [
      {
        "type": "address",
        "name": "wrapper"
      },
      {
        "type": "address",
        "name": "beneficiary"
      },
      {
        "type": "uint128",
        "name": "sizeShares"
      },
      {
        "type": "uint128",
        "name": "bidPx"
      },
      {
        "type": "uint64",
        "name": "expiry"
      },
      {
        "type": "uint128",
        "name": "bond"
      }
    ],
    "outputs": [
      {
        "type": "uint256",
        "name": "id"
      }
    ]
  },
  {
    "name": "take",
    "type": "function",
    "stateMutability": "nonpayable",
    "inputs": [
      {
        "type": "uint256",
        "name": "id"
      },
      {
        "type": "uint128",
        "name": "shares"
      },
      {
        "type": "address",
        "name": "to"
      }
    ],
    "outputs": [
      {
        "type": "bool",
        "name": "filled"
      },
      {
        "type": "uint256",
        "name": "amount"
      }
    ]
  },
  {
    "name": "withdraw",
    "type": "function",
    "stateMutability": "nonpayable",
    "inputs": [
      {
        "type": "uint256",
        "name": "id"
      }
    ],
    "outputs": []
  },
  {
    "name": "claimShares",
    "type": "function",
    "stateMutability": "nonpayable",
    "inputs": [
      {
        "type": "address",
        "name": "wrapper"
      },
      {
        "type": "address",
        "name": "to"
      }
    ],
    "outputs": [
      {
        "type": "uint256"
      }
    ]
  },
  {
    "name": "prune",
    "type": "function",
    "stateMutability": "nonpayable",
    "inputs": [
      {
        "type": "address",
        "name": "wrapper"
      },
      {
        "type": "address",
        "name": "beneficiary"
      }
    ],
    "outputs": []
  },
  {
    "name": "certOf",
    "type": "function",
    "stateMutability": "view",
    "inputs": [
      {
        "type": "uint256",
        "name": "id"
      }
    ],
    "outputs": [
      {
        "type": "tuple",
        "components": [
          {
            "type": "address",
            "name": "maker"
          },
          {
            "type": "address",
            "name": "wrapper"
          },
          {
            "type": "address",
            "name": "beneficiary"
          },
          {
            "type": "uint128",
            "name": "sizeShares"
          },
          {
            "type": "uint128",
            "name": "remainingShares"
          },
          {
            "type": "uint128",
            "name": "bidPx"
          },
          {
            "type": "uint128",
            "name": "bond"
          },
          {
            "type": "uint64",
            "name": "postedAt"
          },
          {
            "type": "uint64",
            "name": "expiry"
          },
          {
            "type": "uint8",
            "name": "status"
          }
        ]
      }
    ]
  },
  {
    "name": "isHonourable",
    "type": "function",
    "stateMutability": "view",
    "inputs": [
      {
        "type": "address",
        "name": "maker"
      }
    ],
    "outputs": [
      {
        "type": "bool"
      }
    ]
  },
  {
    "name": "honouredDepth",
    "type": "function",
    "stateMutability": "view",
    "inputs": [
      {
        "type": "address",
        "name": "wrapper"
      },
      {
        "type": "address",
        "name": "beneficiary"
      },
      {
        "type": "uint64",
        "name": "minExpiry"
      }
    ],
    "outputs": [
      {
        "type": "uint256",
        "name": "shares"
      },
      {
        "type": "uint256",
        "name": "notional"
      },
      {
        "type": "uint128",
        "name": "minBidPx"
      },
      {
        "type": "uint64",
        "name": "soonestExpiry"
      }
    ]
  },
  {
    "name": "committed",
    "type": "function",
    "stateMutability": "view",
    "inputs": [
      {
        "type": "address",
        "name": "maker"
      }
    ],
    "outputs": [
      {
        "type": "uint256"
      }
    ]
  },
  {
    "name": "claimableShares",
    "type": "function",
    "stateMutability": "view",
    "inputs": [
      {
        "type": "address",
        "name": "maker"
      },
      {
        "type": "address",
        "name": "wrapper"
      }
    ],
    "outputs": [
      {
        "type": "uint256"
      }
    ]
  },
  {
    "name": "certCount",
    "type": "function",
    "stateMutability": "view",
    "inputs": [],
    "outputs": [
      {
        "type": "uint256"
      }
    ]
  },
  {
    "name": "Posted",
    "type": "event",
    "inputs": [
      {
        "type": "uint256",
        "name": "id",
        "indexed": true
      },
      {
        "type": "address",
        "name": "maker",
        "indexed": true
      },
      {
        "type": "address",
        "name": "wrapper",
        "indexed": true
      },
      {
        "type": "address",
        "name": "beneficiary"
      },
      {
        "type": "uint128",
        "name": "size"
      },
      {
        "type": "uint128",
        "name": "bidPx"
      },
      {
        "type": "uint128",
        "name": "bond"
      },
      {
        "type": "uint64",
        "name": "expiry"
      }
    ]
  },
  {
    "name": "Filled",
    "type": "event",
    "inputs": [
      {
        "type": "uint256",
        "name": "id",
        "indexed": true
      },
      {
        "type": "address",
        "name": "taker",
        "indexed": true
      },
      {
        "type": "uint128",
        "name": "shares"
      },
      {
        "type": "uint256",
        "name": "paid"
      },
      {
        "type": "uint128",
        "name": "remaining"
      }
    ]
  },
  {
    "name": "Faded",
    "type": "event",
    "inputs": [
      {
        "type": "uint256",
        "name": "id",
        "indexed": true
      },
      {
        "type": "address",
        "name": "taker",
        "indexed": true
      },
      {
        "type": "address",
        "name": "maker",
        "indexed": true
      },
      {
        "type": "uint128",
        "name": "shares"
      },
      {
        "type": "uint256",
        "name": "costOwed"
      },
      {
        "type": "uint128",
        "name": "bondSlashed"
      },
      {
        "type": "bytes4",
        "name": "reason"
      }
    ]
  },
  {
    "name": "Withdrawn",
    "type": "event",
    "inputs": [
      {
        "type": "uint256",
        "name": "id",
        "indexed": true
      },
      {
        "type": "address",
        "name": "maker",
        "indexed": true
      },
      {
        "type": "uint128",
        "name": "bond"
      }
    ]
  },
  {
    "name": "SharesClaimed",
    "type": "event",
    "inputs": [
      {
        "type": "address",
        "name": "maker",
        "indexed": true
      },
      {
        "type": "address",
        "name": "wrapper",
        "indexed": true
      },
      {
        "type": "uint256",
        "name": "shares"
      }
    ]
  }
] as const;
