// HAND-WRITTEN from docs/specs/W3W4-contracts.md and src/interfaces/*.sol (P0) — provisional until web/scripts/sync-abi.mjs
// regenerates it from forge out/. ClosedAuction. The spec names the functions but not their Solidity types: EVERY type here is a GUESS until sync-abi.mjs regenerates this file from out/.
// Source signatures:
//   function list(uint256 noteId, uint128 amount, uint128 startPrice, uint128 floorPrice, uint64 decaySeconds, uint64 endAt) returns (uint256 lotId)
//   function priceAt(uint256 lotId, uint64 t) view returns (uint256)
//   function currentPrice(uint256 lotId) view returns (uint256)
//   function bid(uint256 lotId, uint256 maxPrice) returns (uint256 price)
//   function withdraw(uint256 lotId)
//   function realisedDiscountBps(uint256 lotId) view returns (int256)
//   struct Lot { address seller; address wrapper; uint256 noteId; uint128 amount; uint128 startPrice; uint128 floorPrice; uint128 refPrice; uint64 startAt; uint64 endAt; uint64 decaySeconds; uint32 epochAtMint; uint8 status; address buyer; uint128 clearedPrice; uint64 clearedAt; }
//   function lotOf(uint256 lotId) view returns (Lot)
//   function lotCount() view returns (uint256)
//   event Listed(uint256 indexed lotId, uint256 indexed noteId, address indexed seller, address wrapper, uint128 amount, uint128 startPrice, uint128 floorPrice, uint64 endAt, uint128 refPrice)
//   event Cleared(uint256 indexed lotId, uint256 indexed noteId, address indexed buyer, uint256 price, uint256 discountBpsVsRef, uint64 at)
//   event Withdrawn(uint256 indexed lotId, address indexed seller)
//   error BadParams()
//   error MarketNotClosed()
//   error ReopenedSinceMint()
//   error Ineligible()
//   error LotNotLive()
//   error LotExpired()
//   error PriceAboveMax(uint256 price, uint256 max)
//   error NotSeller()
//   error NotPrinted()
export const closedAuctionAbi = [
  {
    "name": "list",
    "type": "function",
    "stateMutability": "nonpayable",
    "inputs": [
      {
        "type": "uint256",
        "name": "noteId"
      },
      {
        "type": "uint128",
        "name": "amount"
      },
      {
        "type": "uint128",
        "name": "startPrice"
      },
      {
        "type": "uint128",
        "name": "floorPrice"
      },
      {
        "type": "uint64",
        "name": "decaySeconds"
      },
      {
        "type": "uint64",
        "name": "endAt"
      }
    ],
    "outputs": [
      {
        "type": "uint256",
        "name": "lotId"
      }
    ]
  },
  {
    "name": "priceAt",
    "type": "function",
    "stateMutability": "view",
    "inputs": [
      {
        "type": "uint256",
        "name": "lotId"
      },
      {
        "type": "uint64",
        "name": "t"
      }
    ],
    "outputs": [
      {
        "type": "uint256"
      }
    ]
  },
  {
    "name": "currentPrice",
    "type": "function",
    "stateMutability": "view",
    "inputs": [
      {
        "type": "uint256",
        "name": "lotId"
      }
    ],
    "outputs": [
      {
        "type": "uint256"
      }
    ]
  },
  {
    "name": "bid",
    "type": "function",
    "stateMutability": "nonpayable",
    "inputs": [
      {
        "type": "uint256",
        "name": "lotId"
      },
      {
        "type": "uint256",
        "name": "maxPrice"
      }
    ],
    "outputs": [
      {
        "type": "uint256",
        "name": "price"
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
        "name": "lotId"
      }
    ],
    "outputs": []
  },
  {
    "name": "realisedDiscountBps",
    "type": "function",
    "stateMutability": "view",
    "inputs": [
      {
        "type": "uint256",
        "name": "lotId"
      }
    ],
    "outputs": [
      {
        "type": "int256"
      }
    ]
  },
  {
    "name": "lotOf",
    "type": "function",
    "stateMutability": "view",
    "inputs": [
      {
        "type": "uint256",
        "name": "lotId"
      }
    ],
    "outputs": [
      {
        "type": "tuple",
        "components": [
          {
            "type": "address",
            "name": "seller"
          },
          {
            "type": "address",
            "name": "wrapper"
          },
          {
            "type": "uint256",
            "name": "noteId"
          },
          {
            "type": "uint128",
            "name": "amount"
          },
          {
            "type": "uint128",
            "name": "startPrice"
          },
          {
            "type": "uint128",
            "name": "floorPrice"
          },
          {
            "type": "uint128",
            "name": "refPrice"
          },
          {
            "type": "uint64",
            "name": "startAt"
          },
          {
            "type": "uint64",
            "name": "endAt"
          },
          {
            "type": "uint64",
            "name": "decaySeconds"
          },
          {
            "type": "uint32",
            "name": "epochAtMint"
          },
          {
            "type": "uint8",
            "name": "status"
          },
          {
            "type": "address",
            "name": "buyer"
          },
          {
            "type": "uint128",
            "name": "clearedPrice"
          },
          {
            "type": "uint64",
            "name": "clearedAt"
          }
        ]
      }
    ]
  },
  {
    "name": "lotCount",
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
    "name": "Listed",
    "type": "event",
    "inputs": [
      {
        "type": "uint256",
        "name": "lotId",
        "indexed": true
      },
      {
        "type": "uint256",
        "name": "noteId",
        "indexed": true
      },
      {
        "type": "address",
        "name": "seller",
        "indexed": true
      },
      {
        "type": "address",
        "name": "wrapper"
      },
      {
        "type": "uint128",
        "name": "amount"
      },
      {
        "type": "uint128",
        "name": "startPrice"
      },
      {
        "type": "uint128",
        "name": "floorPrice"
      },
      {
        "type": "uint64",
        "name": "endAt"
      },
      {
        "type": "uint128",
        "name": "refPrice"
      }
    ]
  },
  {
    "name": "Cleared",
    "type": "event",
    "inputs": [
      {
        "type": "uint256",
        "name": "lotId",
        "indexed": true
      },
      {
        "type": "uint256",
        "name": "noteId",
        "indexed": true
      },
      {
        "type": "address",
        "name": "buyer",
        "indexed": true
      },
      {
        "type": "uint256",
        "name": "price"
      },
      {
        "type": "uint256",
        "name": "discountBpsVsRef"
      },
      {
        "type": "uint64",
        "name": "at"
      }
    ]
  },
  {
    "name": "Withdrawn",
    "type": "event",
    "inputs": [
      {
        "type": "uint256",
        "name": "lotId",
        "indexed": true
      },
      {
        "type": "address",
        "name": "seller",
        "indexed": true
      }
    ]
  },
  {
    "name": "BadParams",
    "type": "error",
    "inputs": []
  },
  {
    "name": "MarketNotClosed",
    "type": "error",
    "inputs": []
  },
  {
    "name": "ReopenedSinceMint",
    "type": "error",
    "inputs": []
  },
  {
    "name": "Ineligible",
    "type": "error",
    "inputs": []
  },
  {
    "name": "LotNotLive",
    "type": "error",
    "inputs": []
  },
  {
    "name": "LotExpired",
    "type": "error",
    "inputs": []
  },
  {
    "name": "PriceAboveMax",
    "type": "error",
    "inputs": [
      {
        "type": "uint256",
        "name": "price"
      },
      {
        "type": "uint256",
        "name": "max"
      }
    ]
  },
  {
    "name": "NotSeller",
    "type": "error",
    "inputs": []
  },
  {
    "name": "NotPrinted",
    "type": "error",
    "inputs": []
  }
] as const;
