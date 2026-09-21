/**
 * Per-host attestor key: generated on the host, encrypted at rest, never exported.
 *
 * Decision (13 Sep 2026): each host generates its own key on first boot. The keystore lives on the
 * host's persistent volume, encrypted with a password a human sets directly in the hosting provider's
 * secret store. The key is never printed, logged, pasted, or decrypted inside an agent session. Only
 * the address is logged, so the admin can enable it with MarketClock.setAttestor from their own machine.
 *
 * A stolen host key can only make writes that are publicly attributable by tx.from, disputable via the
 * published bundles, and revocable with setAttestor(key, false). Its float is kept deliberately small.
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync, chmodSync } from "node:fs";
import { dirname } from "node:path";
import { Wallet, HDNodeWallet } from "ethers";

export const MIN_PASSWORD_LENGTH = 24;

export interface KeyInfo {
  wallet: Wallet | HDNodeWallet;
  address: string;
  created: boolean;
}

export async function loadOrCreateKey(keystorePath: string, password: string | undefined): Promise<KeyInfo> {
  if (!password || password.length < MIN_PASSWORD_LENGTH) {
    throw new Error(
      `ATTESTOR_KEY_PASSWORD is missing or shorter than ${MIN_PASSWORD_LENGTH} characters. ` +
        "Set it as a sealed variable in the hosting provider's dashboard. It is never read from a file in the repo.",
    );
  }

  if (existsSync(keystorePath)) {
    const json = readFileSync(keystorePath, "utf8");
    const wallet = await Wallet.fromEncryptedJson(json, password);
    return { wallet, address: wallet.address, created: false };
  }

  mkdirSync(dirname(keystorePath), { recursive: true, mode: 0o700 });
  const wallet = Wallet.createRandom();
  const json = await wallet.encrypt(password);
  // Write-once: never overwrite an existing keystore, which would orphan an enabled attestor.
  writeFileSync(keystorePath, json, { mode: 0o600, flag: "wx" });
  chmodSync(keystorePath, 0o600);
  return { wallet, address: wallet.address, created: true };
}
