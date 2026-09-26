// The Allowance contract's interface, shared by the server (allowanceChain.ts) and the dashboard,
// which sends the owner's own transactions from their wallet. Nothing here touches a node, so the
// browser can import it.

import { parseAbi } from "viem";

export const ALLOWANCE_ABI = parseAbi([
  "struct Account { uint256 balance; uint256 reserved; uint256 maxPerTask; uint256 maxPerDay; uint256 expiresAt; uint256 day; uint256 spentToday; bool paused; bool restrict; }",
  // views
  "function accountOf(address owner, address token) view returns (Account a, uint256 available, uint256 spentToday)",
  "function allowed(address owner, address token, bytes32 agentKey) view returns (bool)",
  "function reservations(bytes32 taskKey) view returns (address owner, address token, uint256 amount, uint256 createdAt, uint256 day, bytes32 agentKey, uint8 state)",
  "function reservationsPaused() view returns (bool)",
  "function operator() view returns (address)",
  // the owner, from their own wallet
  "function deposit() payable",
  "function depositToken(address token, uint256 amount)",
  "function withdraw(address token, uint256 amount)",
  "function setRules(address token, uint256 maxPerTask, uint256 maxPerDay, uint256 expiresAt)",
  "function setAllowedAgents(address token, bytes32[] add, bytes32[] remove, bool restrict)",
  "function pause(address token)",
  "function unpause(address token)",
  "function reclaim(bytes32 taskKey)",
  // the operator
  "function reserve(address owner, address token, bytes32 taskKey, bytes32 agentKey, uint256 amount)",
  "function settleMany(bytes32[] taskKeys)",
  "function releaseMany(bytes32[] taskKeys)",
  "event Reserved(address indexed owner, address indexed token, bytes32 indexed taskKey, bytes32 agentKey, uint256 amount)",
  // So a refusal decodes to its name rather than a bare selector.
  "error NotOperator()",
  "error NotAdmin()",
  "error NotOwner()",
  "error ZeroAddress()",
  "error ZeroAmount()",
  "error UnsupportedToken()",
  "error BadRules()",
  "error NoRules()",
  "error AllowancePaused()",
  "error ReservationsArePaused()",
  "error Expired()",
  "error OverTaskLimit()",
  "error OverDailyLimit()",
  "error AgentNotAllowed()",
  "error InsufficientBalance()",
  "error TaskKeyUsed()",
  "error NotReserved()",
  "error TooEarly()",
  "error UseDeposit()",
  "error EthTransferFailed()",
]);

export const ERC20_APPROVE_ABI = parseAbi([
  "function approve(address spender, uint256 amount) returns (bool)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function balanceOf(address owner) view returns (uint256)",
]);
