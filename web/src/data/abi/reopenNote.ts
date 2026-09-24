// HAND-WRITTEN from docs/specs/W3W4-contracts.md and src/interfaces/*.sol (P0) — provisional until web/scripts/sync-abi.mjs
// regenerates it from forge out/. IReopenNote, frozen in the spec (types exact) + ERC1155Min. Event indexing and the two GUESS getters are provisional.
// Source signatures:
//   struct Unit { address wrapper; address issuer; uint128 wrapperShares; uint128 underlyingAtMint; uint32 multiplierNonce; uint32 epochAtMint; uint64 mintedAt; uint64 mintedBlock; }
//   function mint(address wrapper, uint128 wrapperShares, address to) returns (uint256 id)
//   function redeem(uint256 id, uint128 amount, address to)
//   function cancel(uint256 id)
//   function unitOf(uint256 id) view returns (Unit)
//   function outstanding(uint256 id) view returns (uint128)
//   function redeemable(uint256 id) view returns (bool)
//   function safeTransferFrom(address from, address to, uint256 id, uint256 amount, bytes data)
//   function balanceOf(address account, uint256 id) view returns (uint256)
//   function balanceOfBatch(address[] accounts, uint256[] ids) view returns (uint256[])
//   function isApprovedForAll(address account, address operator) view returns (bool)
//   function setApprovalForAll(address operator, bool approved)
//   function uri(uint256 id) view returns (string)
//   function safeBatchTransferFrom(address from, address to, uint256[] ids, uint256[] values, bytes data)
//   function supportsInterface(bytes4 interfaceId) view returns (bool)
//   event ApprovalForAll(address indexed account, address indexed operator, bool approved)
//   event TransferBatch(address indexed operator, address indexed from, address indexed to, uint256[] ids, uint256[] values)
//   error ERC1155NotAuthorized(address operator, address from)
//   error ERC1155ZeroAddress()
//   error ERC1155InsufficientBalance(address from, uint256 id, uint256 balance, uint256 needed)
//   error ERC1155LengthMismatch()
//   error ERC1155UnsafeRecipient(address to)
//   function name() view returns (string)
//   function symbol() view returns (string)
//   function capShares(address wrapper) view returns (uint256)
//   function openInterest(address wrapper) view returns (uint256)
//   event TransferSingle(address indexed operator, address indexed from, address indexed to, uint256 id, uint256 value)
//   event NoteMinted(uint256 indexed id, address indexed issuer, address indexed wrapper, uint128 wrapperShares, uint128 underlyingAtMint, uint32 multiplierNonce, uint32 epochAtMint, address to)
//   event NoteRedeemed(uint256 indexed id, address indexed holder, address to, uint128 wrapperShares, uint128 underlyingAtRedeem, uint32 nonceAtRedeem, uint32 epochNow, bool viaFallback)
//   event NoteCancelled(uint256 indexed id, address indexed issuer, uint128 wrapperShares)
//   error UnsupportedAsset()
//   error MarketNotClosed()
//   error InBlackout()
//   error CapExceeded(uint256 oi, uint256 cap)
//   error ZeroAmount()
//   error NotReopened(uint256 id, uint32 epochAtMint, uint32 epochNow)
//   error NotWholeIssuer()
//   error UnknownNote()
export const reopenNoteAbi = [
  {
    "name": "mint",
    "type": "function",
    "stateMutability": "nonpayable",
    "inputs": [
      {
        "type": "address",
        "name": "wrapper"
      },
      {
        "type": "uint128",
        "name": "wrapperShares"
      },
      {
        "type": "address",
        "name": "to"
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
    "name": "redeem",
    "type": "function",
    "stateMutability": "nonpayable",
    "inputs": [
      {
        "type": "uint256",
        "name": "id"
      },
      {
        "type": "uint128",
        "name": "amount"
      },
      {
        "type": "address",
        "name": "to"
      }
    ],
    "outputs": []
  },
  {
    "name": "cancel",
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
    "name": "unitOf",
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
            "name": "wrapper"
          },
          {
            "type": "address",
            "name": "issuer"
          },
          {
            "type": "uint128",
            "name": "wrapperShares"
          },
          {
            "type": "uint128",
            "name": "underlyingAtMint"
          },
          {
            "type": "uint32",
            "name": "multiplierNonce"
          },
          {
            "type": "uint32",
            "name": "epochAtMint"
          },
          {
            "type": "uint64",
            "name": "mintedAt"
          },
          {
            "type": "uint64",
            "name": "mintedBlock"
          }
        ]
      }
    ]
  },
  {
    "name": "outstanding",
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
        "type": "uint128"
      }
    ]
  },
  {
    "name": "redeemable",
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
        "type": "bool"
      }
    ]
  },
  {
    "name": "safeTransferFrom",
    "type": "function",
    "stateMutability": "nonpayable",
    "inputs": [
      {
        "type": "address",
        "name": "from"
      },
      {
        "type": "address",
        "name": "to"
      },
      {
        "type": "uint256",
        "name": "id"
      },
      {
        "type": "uint256",
        "name": "amount"
      },
      {
        "type": "bytes",
        "name": "data"
      }
    ],
    "outputs": []
  },
  {
    "name": "balanceOf",
    "type": "function",
    "stateMutability": "view",
    "inputs": [
      {
        "type": "address",
        "name": "account"
      },
      {
        "type": "uint256",
        "name": "id"
      }
    ],
    "outputs": [
      {
        "type": "uint256"
      }
    ]
  },
  {
    "name": "balanceOfBatch",
    "type": "function",
    "stateMutability": "view",
    "inputs": [
      {
        "type": "address[]",
        "name": "accounts"
      },
      {
        "type": "uint256[]",
        "name": "ids"
      }
    ],
    "outputs": [
      {
        "type": "uint256[]"
      }
    ]
  },
  {
    "name": "isApprovedForAll",
    "type": "function",
    "stateMutability": "view",
    "inputs": [
      {
        "type": "address",
        "name": "account"
      },
      {
        "type": "address",
        "name": "operator"
      }
    ],
    "outputs": [
      {
        "type": "bool"
      }
    ]
  },
  {
    "name": "setApprovalForAll",
    "type": "function",
    "stateMutability": "nonpayable",
    "inputs": [
      {
        "type": "address",
        "name": "operator"
      },
      {
        "type": "bool",
        "name": "approved"
      }
    ],
    "outputs": []
  },
  {
    "name": "uri",
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
        "type": "string"
      }
    ]
  },
  {
    "name": "safeBatchTransferFrom",
    "type": "function",
    "stateMutability": "nonpayable",
    "inputs": [
      {
        "type": "address",
        "name": "from"
      },
      {
        "type": "address",
        "name": "to"
      },
      {
        "type": "uint256[]",
        "name": "ids"
      },
      {
        "type": "uint256[]",
        "name": "values"
      },
      {
        "type": "bytes",
        "name": "data"
      }
    ],
    "outputs": []
  },
  {
    "name": "supportsInterface",
    "type": "function",
    "stateMutability": "view",
    "inputs": [
      {
        "type": "bytes4",
        "name": "interfaceId"
      }
    ],
    "outputs": [
      {
        "type": "bool"
      }
    ]
  },
  {
    "name": "ApprovalForAll",
    "type": "event",
    "inputs": [
      {
        "type": "address",
        "name": "account",
        "indexed": true
      },
      {
        "type": "address",
        "name": "operator",
        "indexed": true
      },
      {
        "type": "bool",
        "name": "approved"
      }
    ]
  },
  {
    "name": "TransferBatch",
    "type": "event",
    "inputs": [
      {
        "type": "address",
        "name": "operator",
        "indexed": true
      },
      {
        "type": "address",
        "name": "from",
        "indexed": true
      },
      {
        "type": "address",
        "name": "to",
        "indexed": true
      },
      {
        "type": "uint256[]",
        "name": "ids"
      },
      {
        "type": "uint256[]",
        "name": "values"
      }
    ]
  },
  {
    "name": "ERC1155NotAuthorized",
    "type": "error",
    "inputs": [
      {
        "type": "address",
        "name": "operator"
      },
      {
        "type": "address",
        "name": "from"
      }
    ]
  },
  {
    "name": "ERC1155ZeroAddress",
    "type": "error",
    "inputs": []
  },
  {
    "name": "ERC1155InsufficientBalance",
    "type": "error",
    "inputs": [
      {
        "type": "address",
        "name": "from"
      },
      {
        "type": "uint256",
        "name": "id"
      },
      {
        "type": "uint256",
        "name": "balance"
      },
      {
        "type": "uint256",
        "name": "needed"
      }
    ]
  },
  {
    "name": "ERC1155LengthMismatch",
    "type": "error",
    "inputs": []
  },
  {
    "name": "ERC1155UnsafeRecipient",
    "type": "error",
    "inputs": [
      {
        "type": "address",
        "name": "to"
      }
    ]
  },
  {
    "name": "name",
    "type": "function",
    "stateMutability": "view",
    "inputs": [],
    "outputs": [
      {
        "type": "string"
      }
    ]
  },
  {
    "name": "symbol",
    "type": "function",
    "stateMutability": "view",
    "inputs": [],
    "outputs": [
      {
        "type": "string"
      }
    ]
  },
  {
    "name": "capShares",
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
        "type": "uint256"
      }
    ]
  },
  {
    "name": "openInterest",
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
        "type": "uint256"
      }
    ]
  },
  {
    "name": "TransferSingle",
    "type": "event",
    "inputs": [
      {
        "type": "address",
        "name": "operator",
        "indexed": true
      },
      {
        "type": "address",
        "name": "from",
        "indexed": true
      },
      {
        "type": "address",
        "name": "to",
        "indexed": true
      },
      {
        "type": "uint256",
        "name": "id"
      },
      {
        "type": "uint256",
        "name": "value"
      }
    ]
  },
  {
    "name": "NoteMinted",
    "type": "event",
    "inputs": [
      {
        "type": "uint256",
        "name": "id",
        "indexed": true
      },
      {
        "type": "address",
        "name": "issuer",
        "indexed": true
      },
      {
        "type": "address",
        "name": "wrapper",
        "indexed": true
      },
      {
        "type": "uint128",
        "name": "wrapperShares"
      },
      {
        "type": "uint128",
        "name": "underlyingAtMint"
      },
      {
        "type": "uint32",
        "name": "multiplierNonce"
      },
      {
        "type": "uint32",
        "name": "epochAtMint"
      },
      {
        "type": "address",
        "name": "to"
      }
    ]
  },
  {
    "name": "NoteRedeemed",
    "type": "event",
    "inputs": [
      {
        "type": "uint256",
        "name": "id",
        "indexed": true
      },
      {
        "type": "address",
        "name": "holder",
        "indexed": true
      },
      {
        "type": "address",
        "name": "to"
      },
      {
        "type": "uint128",
        "name": "wrapperShares"
      },
      {
        "type": "uint128",
        "name": "underlyingAtRedeem"
      },
      {
        "type": "uint32",
        "name": "nonceAtRedeem"
      },
      {
        "type": "uint32",
        "name": "epochNow"
      },
      {
        "type": "bool",
        "name": "viaFallback"
      }
    ]
  },
  {
    "name": "NoteCancelled",
    "type": "event",
    "inputs": [
      {
        "type": "uint256",
        "name": "id",
        "indexed": true
      },
      {
        "type": "address",
        "name": "issuer",
        "indexed": true
      },
      {
        "type": "uint128",
        "name": "wrapperShares"
      }
    ]
  },
  {
    "name": "UnsupportedAsset",
    "type": "error",
    "inputs": []
  },
  {
    "name": "MarketNotClosed",
    "type": "error",
    "inputs": []
  },
  {
    "name": "InBlackout",
    "type": "error",
    "inputs": []
  },
  {
    "name": "CapExceeded",
    "type": "error",
    "inputs": [
      {
        "type": "uint256",
        "name": "oi"
      },
      {
        "type": "uint256",
        "name": "cap"
      }
    ]
  },
  {
    "name": "ZeroAmount",
    "type": "error",
    "inputs": []
  },
  {
    "name": "NotReopened",
    "type": "error",
    "inputs": [
      {
        "type": "uint256",
        "name": "id"
      },
      {
        "type": "uint32",
        "name": "epochAtMint"
      },
      {
        "type": "uint32",
        "name": "epochNow"
      }
    ]
  },
  {
    "name": "NotWholeIssuer",
    "type": "error",
    "inputs": []
  },
  {
    "name": "UnknownNote",
    "type": "error",
    "inputs": []
  }
] as const;
