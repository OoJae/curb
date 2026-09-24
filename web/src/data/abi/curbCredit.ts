// HAND-WRITTEN from docs/specs/W3W4-contracts.md — provisional until web/scripts/sync-abi.mjs
// regenerates it from forge out/. CurbCredit. Names from the spec; types are GUESSES except Refusal (typed in the spec). Regenerate with sync-abi.mjs.
// Source signatures:
//   struct Cure { bool active; bool lastOpen; uint64 openedAt; uint64 lastTickAt; uint64 openSecondsUsed; uint128 priceAtBreach; }
//   function ltvFor(address a) view returns (uint256)
//   function realisable(address a) view returns (uint256)
//   function debtOf(address b, address a) view returns (uint256)
//   function limitOf(address b, address a) view returns (uint256)
//   function isBreached(address b, address a) view returns (bool known, bool breached)
//   function cureOf(address b, address a) view returns (Cure)
//   function totalCollateral(address a) view returns (uint256)
//   function totalPrincipal(address a) view returns (uint256)
//   function seized(address a) view returns (uint256)
//   function positions(address b, address a) view returns (uint128 collateral, uint128 principal, uint128 accrued, uint64 lastAccrual)
//   function fund(uint256 amt)
//   function deposit(address a, uint256 s)
//   function withdraw(address a, uint256 s) returns (bool)
//   function borrow(address a, uint256 amt) returns (bool)
//   function repay(address b, address a, uint256 amt)
//   function flagBreach(address b, address a)
//   function tick(address b, address a)
//   function liquidate(address b, address a)
//   event Refusal(address indexed who, address indexed asset, bytes4 indexed reason, uint256 requested, uint256 allowed)
//   event Borrowed(address indexed b, address indexed a, uint256 amt, uint256 debtAfter, uint256 ltvBps)
//   event Deposited(address indexed b, address indexed a, uint256 s)
//   event Repaid(address indexed b, address indexed a, uint256 amt)
//   event BreachOpened(address indexed b, address indexed a, uint256 debt, uint256 limit, uint256 priceAtBreach, uint256 ltvBps)
//   event CureTicked(address indexed b, address indexed a, bool open, uint256 used, uint256 required)
//   event Liquidated(address indexed b, address indexed a, uint256 seized, uint256 cleared, uint256 badDebt, uint256 pFresh, uint256 pBreach)
export const curbCreditAbi = [
  {
    "name": "ltvFor",
    "type": "function",
    "stateMutability": "view",
    "inputs": [
      {
        "type": "address",
        "name": "a"
      }
    ],
    "outputs": [
      {
        "type": "uint256"
      }
    ]
  },
  {
    "name": "realisable",
    "type": "function",
    "stateMutability": "view",
    "inputs": [
      {
        "type": "address",
        "name": "a"
      }
    ],
    "outputs": [
      {
        "type": "uint256"
      }
    ]
  },
  {
    "name": "debtOf",
    "type": "function",
    "stateMutability": "view",
    "inputs": [
      {
        "type": "address",
        "name": "b"
      },
      {
        "type": "address",
        "name": "a"
      }
    ],
    "outputs": [
      {
        "type": "uint256"
      }
    ]
  },
  {
    "name": "limitOf",
    "type": "function",
    "stateMutability": "view",
    "inputs": [
      {
        "type": "address",
        "name": "b"
      },
      {
        "type": "address",
        "name": "a"
      }
    ],
    "outputs": [
      {
        "type": "uint256"
      }
    ]
  },
  {
    "name": "isBreached",
    "type": "function",
    "stateMutability": "view",
    "inputs": [
      {
        "type": "address",
        "name": "b"
      },
      {
        "type": "address",
        "name": "a"
      }
    ],
    "outputs": [
      {
        "type": "bool",
        "name": "known"
      },
      {
        "type": "bool",
        "name": "breached"
      }
    ]
  },
  {
    "name": "cureOf",
    "type": "function",
    "stateMutability": "view",
    "inputs": [
      {
        "type": "address",
        "name": "b"
      },
      {
        "type": "address",
        "name": "a"
      }
    ],
    "outputs": [
      {
        "type": "tuple",
        "components": [
          {
            "type": "bool",
            "name": "active"
          },
          {
            "type": "bool",
            "name": "lastOpen"
          },
          {
            "type": "uint64",
            "name": "openedAt"
          },
          {
            "type": "uint64",
            "name": "lastTickAt"
          },
          {
            "type": "uint64",
            "name": "openSecondsUsed"
          },
          {
            "type": "uint128",
            "name": "priceAtBreach"
          }
        ]
      }
    ]
  },
  {
    "name": "totalCollateral",
    "type": "function",
    "stateMutability": "view",
    "inputs": [
      {
        "type": "address",
        "name": "a"
      }
    ],
    "outputs": [
      {
        "type": "uint256"
      }
    ]
  },
  {
    "name": "totalPrincipal",
    "type": "function",
    "stateMutability": "view",
    "inputs": [
      {
        "type": "address",
        "name": "a"
      }
    ],
    "outputs": [
      {
        "type": "uint256"
      }
    ]
  },
  {
    "name": "seized",
    "type": "function",
    "stateMutability": "view",
    "inputs": [
      {
        "type": "address",
        "name": "a"
      }
    ],
    "outputs": [
      {
        "type": "uint256"
      }
    ]
  },
  {
    "name": "positions",
    "type": "function",
    "stateMutability": "view",
    "inputs": [
      {
        "type": "address",
        "name": "b"
      },
      {
        "type": "address",
        "name": "a"
      }
    ],
    "outputs": [
      {
        "type": "uint128",
        "name": "collateral"
      },
      {
        "type": "uint128",
        "name": "principal"
      },
      {
        "type": "uint128",
        "name": "accrued"
      },
      {
        "type": "uint64",
        "name": "lastAccrual"
      }
    ]
  },
  {
    "name": "fund",
    "type": "function",
    "stateMutability": "nonpayable",
    "inputs": [
      {
        "type": "uint256",
        "name": "amt"
      }
    ],
    "outputs": []
  },
  {
    "name": "deposit",
    "type": "function",
    "stateMutability": "nonpayable",
    "inputs": [
      {
        "type": "address",
        "name": "a"
      },
      {
        "type": "uint256",
        "name": "s"
      }
    ],
    "outputs": []
  },
  {
    "name": "withdraw",
    "type": "function",
    "stateMutability": "nonpayable",
    "inputs": [
      {
        "type": "address",
        "name": "a"
      },
      {
        "type": "uint256",
        "name": "s"
      }
    ],
    "outputs": [
      {
        "type": "bool"
      }
    ]
  },
  {
    "name": "borrow",
    "type": "function",
    "stateMutability": "nonpayable",
    "inputs": [
      {
        "type": "address",
        "name": "a"
      },
      {
        "type": "uint256",
        "name": "amt"
      }
    ],
    "outputs": [
      {
        "type": "bool"
      }
    ]
  },
  {
    "name": "repay",
    "type": "function",
    "stateMutability": "nonpayable",
    "inputs": [
      {
        "type": "address",
        "name": "b"
      },
      {
        "type": "address",
        "name": "a"
      },
      {
        "type": "uint256",
        "name": "amt"
      }
    ],
    "outputs": []
  },
  {
    "name": "flagBreach",
    "type": "function",
    "stateMutability": "nonpayable",
    "inputs": [
      {
        "type": "address",
        "name": "b"
      },
      {
        "type": "address",
        "name": "a"
      }
    ],
    "outputs": []
  },
  {
    "name": "tick",
    "type": "function",
    "stateMutability": "nonpayable",
    "inputs": [
      {
        "type": "address",
        "name": "b"
      },
      {
        "type": "address",
        "name": "a"
      }
    ],
    "outputs": []
  },
  {
    "name": "liquidate",
    "type": "function",
    "stateMutability": "nonpayable",
    "inputs": [
      {
        "type": "address",
        "name": "b"
      },
      {
        "type": "address",
        "name": "a"
      }
    ],
    "outputs": []
  },
  {
    "name": "Refusal",
    "type": "event",
    "inputs": [
      {
        "type": "address",
        "name": "who",
        "indexed": true
      },
      {
        "type": "address",
        "name": "asset",
        "indexed": true
      },
      {
        "type": "bytes4",
        "name": "reason",
        "indexed": true
      },
      {
        "type": "uint256",
        "name": "requested"
      },
      {
        "type": "uint256",
        "name": "allowed"
      }
    ]
  },
  {
    "name": "Borrowed",
    "type": "event",
    "inputs": [
      {
        "type": "address",
        "name": "b",
        "indexed": true
      },
      {
        "type": "address",
        "name": "a",
        "indexed": true
      },
      {
        "type": "uint256",
        "name": "amt"
      },
      {
        "type": "uint256",
        "name": "debtAfter"
      },
      {
        "type": "uint256",
        "name": "ltvBps"
      }
    ]
  },
  {
    "name": "Deposited",
    "type": "event",
    "inputs": [
      {
        "type": "address",
        "name": "b",
        "indexed": true
      },
      {
        "type": "address",
        "name": "a",
        "indexed": true
      },
      {
        "type": "uint256",
        "name": "s"
      }
    ]
  },
  {
    "name": "Repaid",
    "type": "event",
    "inputs": [
      {
        "type": "address",
        "name": "b",
        "indexed": true
      },
      {
        "type": "address",
        "name": "a",
        "indexed": true
      },
      {
        "type": "uint256",
        "name": "amt"
      }
    ]
  },
  {
    "name": "BreachOpened",
    "type": "event",
    "inputs": [
      {
        "type": "address",
        "name": "b",
        "indexed": true
      },
      {
        "type": "address",
        "name": "a",
        "indexed": true
      },
      {
        "type": "uint256",
        "name": "debt"
      },
      {
        "type": "uint256",
        "name": "limit"
      },
      {
        "type": "uint256",
        "name": "priceAtBreach"
      },
      {
        "type": "uint256",
        "name": "ltvBps"
      }
    ]
  },
  {
    "name": "CureTicked",
    "type": "event",
    "inputs": [
      {
        "type": "address",
        "name": "b",
        "indexed": true
      },
      {
        "type": "address",
        "name": "a",
        "indexed": true
      },
      {
        "type": "bool",
        "name": "open"
      },
      {
        "type": "uint256",
        "name": "used"
      },
      {
        "type": "uint256",
        "name": "required"
      }
    ]
  },
  {
    "name": "Liquidated",
    "type": "event",
    "inputs": [
      {
        "type": "address",
        "name": "b",
        "indexed": true
      },
      {
        "type": "address",
        "name": "a",
        "indexed": true
      },
      {
        "type": "uint256",
        "name": "seized"
      },
      {
        "type": "uint256",
        "name": "cleared"
      },
      {
        "type": "uint256",
        "name": "badDebt"
      },
      {
        "type": "uint256",
        "name": "pFresh"
      },
      {
        "type": "uint256",
        "name": "pBreach"
      }
    ]
  }
] as const;
