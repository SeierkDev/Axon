// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// Building the snipe-exemption list, which every launch call needs and no test should spell out by hand.
///
/// `launch` takes an address[] rather than a single address because Pons taxes the launch block hard and
/// exempts only the wallets it is handed. A previous launch passed one address and somebody who bought at the
/// open paid ~98% for it, so the tests exercise the list shape everywhere rather than the old single-wallet one.
abstract contract ExemptHelper {
    /// No exemptions at all, and therefore no dev buy.
    function _noExempt() internal pure returns (address[] memory list) {
        list = new address[](0);
    }

    /// One wallet, which is also where a dev buy in the same transaction is sent.
    function _exempt(address a) internal pure returns (address[] memory list) {
        list = new address[](1);
        list[0] = a;
    }

    /// The dev buy wallet first, then everyone else who should not pay the launch-block tax.
    function _exempt(address a, address b) internal pure returns (address[] memory list) {
        list = new address[](2);
        list[0] = a;
        list[1] = b;
    }

    function _exempt(address a, address b, address c) internal pure returns (address[] memory list) {
        list = new address[](3);
        list[0] = a;
        list[1] = b;
        list[2] = c;
    }
}
