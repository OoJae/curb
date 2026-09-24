// HAND-WRITTEN from docs/specs/W3W4-contracts.md — provisional until web/scripts/sync-abi.mjs
// regenerates it from forge out/. IReopenPointer, frozen in the spec (types exact).
// Source signatures:
//   struct Epoch { uint64 shutSeenAt; uint64 openedAt; uint64 openedBlock; uint128 print; uint64 printedAt; }
//   event Shut(address indexed wrapper, uint32 indexed epoch, uint64 at)
//   event Reopened(address indexed wrapper, uint32 indexed epoch, uint64 shutSeenAt, uint64 openedAt, uint128 primaryCapUsd)
//   event Printed(address indexed wrapper, uint32 indexed epoch, uint128 print, uint64 at)
//   function observe(address wrapper) returns (uint32 epoch, bool open)
//   function recordPrint(address wrapper, uint32 epoch) returns (uint128)
//   function epochOf(address wrapper) view returns (uint32)
//   function isOpen(address wrapper) view returns (bool)
//   function epochInfo(address wrapper, uint32 epoch) view returns (Epoch)
//   error UnknownEpoch()
//   error PrintTooEarly(uint64 readyAt)
//   error PrintTooLate(uint64 deadline)
//   error AlreadyPrinted()
//   error MarketShut()
export const reopenPointerAbi = [
  {
    "name": "Shut",
    "type": "event",
    "inputs": [
      {
        "type": "address",
        "name": "wrapper",
        "indexed": true
      },
      {
        "type": "uint32",
        "name": "epoch",
        "indexed": true
      },
      {
        "type": "uint64",
        "name": "at"
      }
    ]
  },
  {
    "name": "Reopened",
    "type": "event",
    "inputs": [
      {
        "type": "address",
        "name": "wrapper",
        "indexed": true
      },
      {
        "type": "uint32",
        "name": "epoch",
        "indexed": true
      },
      {
        "type": "uint64",
        "name": "shutSeenAt"
      },
      {
        "type": "uint64",
        "name": "openedAt"
      },
      {
        "type": "uint128",
        "name": "primaryCapUsd"
      }
    ]
  },
  {
    "name": "Printed",
    "type": "event",
    "inputs": [
      {
        "type": "address",
        "name": "wrapper",
        "indexed": true
      },
      {
        "type": "uint32",
        "name": "epoch",
        "indexed": true
      },
      {
        "type": "uint128",
        "name": "print"
      },
      {
        "type": "uint64",
        "name": "at"
      }
    ]
  },
  {
    "name": "observe",
    "type": "function",
    "stateMutability": "nonpayable",
    "inputs": [
      {
        "type": "address",
        "name": "wrapper"
      }
    ],
    "outputs": [
      {
        "type": "uint32",
        "name": "epoch"
      },
      {
        "type": "bool",
        "name": "open"
      }
    ]
  },
  {
    "name": "recordPrint",
    "type": "function",
    "stateMutability": "nonpayable",
    "inputs": [
      {
        "type": "address",
        "name": "wrapper"
      },
      {
        "type": "uint32",
        "name": "epoch"
      }
    ],
    "outputs": [
      {
        "type": "uint128"
      }
    ]
  },
  {
    "name": "epochOf",
    "type": "function",
    "stateMutability": "view",
    "inputs": [
      {
        "type": "address",
        "name": "wrapper"
      }
    ],
    "outputs": [
      {
        "type": "uint32"
      }
    ]
  },
  {
    "name": "isOpen",
    "type": "function",
    "stateMutability": "view",
    "inputs": [
      {
        "type": "address",
        "name": "wrapper"
      }
    ],
    "outputs": [
      {
        "type": "bool"
      }
    ]
  },
  {
    "name": "epochInfo",
    "type": "function",
    "stateMutability": "view",
    "inputs": [
      {
        "type": "address",
        "name": "wrapper"
      },
      {
        "type": "uint32",
        "name": "epoch"
      }
    ],
    "outputs": [
      {
        "type": "tuple",
        "components": [
          {
            "type": "uint64",
            "name": "shutSeenAt"
          },
          {
            "type": "uint64",
            "name": "openedAt"
          },
          {
            "type": "uint64",
            "name": "openedBlock"
          },
          {
            "type": "uint128",
            "name": "print"
          },
          {
            "type": "uint64",
            "name": "printedAt"
          }
        ]
      }
    ]
  },
  {
    "name": "UnknownEpoch",
    "type": "error",
    "inputs": []
  },
  {
    "name": "PrintTooEarly",
    "type": "error",
    "inputs": [
      {
        "type": "uint64",
        "name": "readyAt"
      }
    ]
  },
  {
    "name": "PrintTooLate",
    "type": "error",
    "inputs": [
      {
        "type": "uint64",
        "name": "deadline"
      }
    ]
  },
  {
    "name": "AlreadyPrinted",
    "type": "error",
    "inputs": []
  },
  {
    "name": "MarketShut",
    "type": "error",
    "inputs": []
  }
] as const;
