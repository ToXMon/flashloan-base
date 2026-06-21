import { expect } from "chai";
import hre from "hardhat";

describe("Hardhat V3 Network Probe", function () {
  this.timeout(30_000);

  it("should probe network API", async function () {
    console.log("network keys:", Object.keys(hre.network).join(", "));

    // Try getOrCreate
    try {
      const net = await hre.network.getOrCreate();
      console.log("getOrCreate result keys:", Object.keys(net).join(", "));
      console.log("net.provider:", net.provider);
      console.log("net.provider type:", typeof net.provider);
      if (net.provider) {
        console.log("provider keys:", Object.keys(net.provider).join(", ").slice(0, 200));
        // Try to get accounts
        try {
          const accounts = await net.provider.request({ method: "eth_accounts" });
          console.log("accounts:", accounts.slice(0, 3));
        } catch (e: any) {
          console.log("eth_accounts error:", e.message?.slice(0, 100));
        }
      }
    } catch (e: any) {
      console.log("getOrCreate error:", e.message?.slice(0, 200));
    }

    // Try connect
    try {
      const net2 = await hre.network.connect();
      console.log("connect result keys:", Object.keys(net2).join(", ").slice(0, 200));
    } catch (e: any) {
      console.log("connect error:", e.message?.slice(0, 200));
    }

    expect(true).to.equal(true);
  });
});
