import { expect } from "chai";
import { ethers } from "hardhat";
import { SEARToken, HourlyCredits, Registry, Treasury, ProductionOracle } from "../typechain-types";
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import { time } from "@nomicfoundation/hardhat-network-helpers";

describe("Research Benchmarks", function () {
  this.timeout(300000);

  let searToken: SEARToken;
  let hourlyCredits: HourlyCredits;
  let registry: Registry;
  let treasury: Treasury;
  let productionOracle: ProductionOracle;
  let owner: HardhatEthersSigner;
  let signers: HardhatEthersSigner[];

  const STAKE = ethers.parseEther("100");
  const LARGE = ethers.parseEther("1000");
  const POOL = ethers.parseEther("100000");

  interface Result { name: string; gas: bigint; params: Record<string, any>; }
  const results: Result[] = [];

  async function sign(s: HardhatEthersSigner, pid: string, hid: number, wh: bigint, ev: string, addr: string): Promise<string> {
    const cid = (await ethers.provider.getNetwork()).chainId;
    return s.signMessage(ethers.getBytes(ethers.solidityPackedKeccak256(["uint256", "address", "bytes32", "uint256", "uint64", "bytes32"], [cid, addr, pid, hid, wh, ev])));
  }

  async function deploy() {
    searToken = await (await ethers.getContractFactory("SEARToken")).deploy(owner.address);
    hourlyCredits = await (await ethers.getContractFactory("HourlyCredits")).deploy(owner.address);
    registry = await (await ethers.getContractFactory("Registry")).deploy(await searToken.getAddress(), owner.address);
    treasury = await (await ethers.getContractFactory("Treasury")).deploy(await searToken.getAddress(), await registry.getAddress(), owner.address);
    productionOracle = await (await ethers.getContractFactory("ProductionOracle")).deploy(await registry.getAddress(), await hourlyCredits.getAddress(), await treasury.getAddress(), owner.address);
    await searToken.setTreasury(await treasury.getAddress());
    await hourlyCredits.setProductionOracle(await productionOracle.getAddress());
    await registry.setProductionOracle(await productionOracle.getAddress());
    await treasury.setProductionOracle(await productionOracle.getAddress());
  }

  async function setupV(n: number): Promise<HardhatEthersSigner[]> {
    const v = signers.slice(1, 1 + n);
    await searToken.setTreasury(owner.address);
    for (const x of v) await searToken.mint(x.address, LARGE);
    await searToken.mint(owner.address, POOL);
    await searToken.setTreasury(await treasury.getAddress());
    await searToken.approve(await treasury.getAddress(), POOL);
    await treasury.deposit(POOL);
    for (const x of v) {
      await searToken.connect(x).approve(await registry.getAddress(), STAKE);
      await registry.connect(x).stakeAsVerifier(STAKE);
      await registry.addToAllowlist(x.address);
      await registry.connect(x).activateVerifier();
    }
    return v;
  }

  before(async () => { signers = await ethers.getSigners(); owner = signers[0]; });
  after(() => {
    console.log("\n=== RESEARCH BENCHMARKS ===");
    for (const r of results) console.log(`${r.name}: ${r.gas} gas | ${JSON.stringify(r.params)}`);
    console.log("===========================");
  });

  describe("RQ2: Quorum", function () {
    for (const q of [5000, 6667, 7500]) {
      it(`${q / 100}%`, async function () {
        await deploy();
        const v = await setupV(5);
        await registry.setQuorumBps(q);
        const tx = await registry.connect(signers[10]).registerProducer(ethers.keccak256(ethers.toUtf8Bytes(`Q${q}`)), ethers.keccak256(ethers.toUtf8Bytes("m")), signers[10].address);
        const pid = registry.interface.parseLog((await tx.wait())?.logs.find(l => registry.interface.parseLog(l as any)?.name === "ProducerRegistered") as any)?.args.producerId;
        const hid = Math.floor(Date.now() / 1000 / 3600), ev = ethers.keccak256(ethers.toUtf8Bytes("e")), req = Math.ceil((5 * q) / 10000);
        let gas = 0n;
        for (let i = 0; i < req; i++) gas += (await (await productionOracle.connect(v[i]).submitProduction(pid, hid, 5000n, ev, await sign(v[i], pid, hid, 5000n, ev, await productionOracle.getAddress()))).wait())?.gasUsed || 0n;
        await time.increase(3601);
        gas += (await (await productionOracle.finalizeProduction(pid, hid)).wait())?.gasUsed || 0n;
        results.push({ name: `Quorum ${q / 100}%`, gas, params: { q, req } });
        expect(await productionOracle.isFinalized(await productionOracle.getClaimKey(pid, hid))).to.be.true;
      });
    }
  });

  describe("RQ3: Hourly vs Daily", function () {
    it("hourly 24h", async function () {
      await deploy();
      const v = await setupV(3);
      const tx = await registry.connect(signers[10]).registerProducer(ethers.keccak256(ethers.toUtf8Bytes("H")), ethers.keccak256(ethers.toUtf8Bytes("m")), signers[10].address);
      const pid = registry.interface.parseLog((await tx.wait())?.logs.find(l => registry.interface.parseLog(l as any)?.name === "ProducerRegistered") as any)?.args.producerId;
      const base = Math.floor(Date.now() / 1000 / 3600), ev = ethers.keccak256(ethers.toUtf8Bytes("e"));
      let gas = 0n;
      for (let h = 0; h < 24; h++) {
        for (const x of v) gas += (await (await productionOracle.connect(x).submitProduction(pid, base + h, 1000n, ev, await sign(x, pid, base + h, 1000n, ev, await productionOracle.getAddress()))).wait())?.gasUsed || 0n;
        await time.increase(3601);
        gas += (await (await productionOracle.finalizeProduction(pid, base + h)).wait())?.gasUsed || 0n;
      }
      results.push({ name: "Hourly 24h", gas, params: { hours: 24 } });
    });

    it("daily 1 claim", async function () {
      await deploy();
      const v = await setupV(3);
      const tx = await registry.connect(signers[10]).registerProducer(ethers.keccak256(ethers.toUtf8Bytes("D")), ethers.keccak256(ethers.toUtf8Bytes("m")), signers[10].address);
      const pid = registry.interface.parseLog((await tx.wait())?.logs.find(l => registry.interface.parseLog(l as any)?.name === "ProducerRegistered") as any)?.args.producerId;
      const hid = Math.floor(Date.now() / 1000 / 3600), ev = ethers.keccak256(ethers.toUtf8Bytes("e"));
      let gas = 0n;
      for (const x of v) gas += (await (await productionOracle.connect(x).submitProduction(pid, hid, 24000n, ev, await sign(x, pid, hid, 24000n, ev, await productionOracle.getAddress()))).wait())?.gasUsed || 0n;
      await time.increase(3601);
      gas += (await (await productionOracle.finalizeProduction(pid, hid)).wait())?.gasUsed || 0n;
      results.push({ name: "Daily 1 claim", gas, params: { claims: 1 } });
    });

    it("ratio", async function () {
      const h = results.find(r => r.name === "Hourly 24h");
      const d = results.find(r => r.name === "Daily 1 claim");
      if (h && d) {
        const ratio = Number(h.gas) / Number(d.gas);
        console.log(`\n    Overhead: ${ratio.toFixed(2)}x\n`);
        results.push({ name: "Overhead", gas: BigInt(Math.round(ratio * 100)), params: { ratio: ratio.toFixed(2) } });
      }
      expect(true).to.be.true;
    });
  });

  describe("RQ4: Scaling", function () {
    for (const n of [3, 5]) {
      it(`${n} verifiers`, async function () {
        await deploy();
        const v = await setupV(n);
        const tx = await registry.connect(signers[n + 1]).registerProducer(ethers.keccak256(ethers.toUtf8Bytes(`V${n}`)), ethers.keccak256(ethers.toUtf8Bytes("m")), signers[n + 1].address);
        const pid = registry.interface.parseLog((await tx.wait())?.logs.find(l => registry.interface.parseLog(l as any)?.name === "ProducerRegistered") as any)?.args.producerId;
        const hid = Math.floor(Date.now() / 1000 / 3600), ev = ethers.keccak256(ethers.toUtf8Bytes("e"));
        let gas = 0n;
        for (const x of v) gas += (await (await productionOracle.connect(x).submitProduction(pid, hid, 5000n, ev, await sign(x, pid, hid, 5000n, ev, await productionOracle.getAddress()))).wait())?.gasUsed || 0n;
        await time.increase(3601);
        gas += (await (await productionOracle.finalizeProduction(pid, hid)).wait())?.gasUsed || 0n;
        results.push({ name: `${n} verifiers`, gas, params: { n } });
        expect(await productionOracle.isFinalized(await productionOracle.getClaimKey(pid, hid))).to.be.true;
      });
    }
  });

  describe("RQ5: Latency", function () {
    it("decentralized", async function () {
      await deploy();
      const v = await setupV(3);
      const tx = await registry.connect(signers[10]).registerProducer(ethers.keccak256(ethers.toUtf8Bytes("L")), ethers.keccak256(ethers.toUtf8Bytes("m")), signers[10].address);
      const pid = registry.interface.parseLog((await tx.wait())?.logs.find(l => registry.interface.parseLog(l as any)?.name === "ProducerRegistered") as any)?.args.producerId;
      const hid = Math.floor(Date.now() / 1000 / 3600), ev = ethers.keccak256(ethers.toUtf8Bytes("e"));
      const t0 = (await ethers.provider.getBlock("latest"))?.timestamp || 0;
      for (const x of v) await productionOracle.connect(x).submitProduction(pid, hid, 5000n, ev, await sign(x, pid, hid, 5000n, ev, await productionOracle.getAddress()));
      await time.increase(3601);
      await productionOracle.finalizeProduction(pid, hid);
      const t1 = (await ethers.provider.getBlock("latest"))?.timestamp || 0;
      results.push({ name: "Decentralized", gas: 0n, params: { latency: t1 - t0 } });
      console.log(`\n    Decentralized: ${t1 - t0}s\n`);
      expect(await productionOracle.isFinalized(await productionOracle.getClaimKey(pid, hid))).to.be.true;
    });

    it("baseline", async function () {
      await deploy();
      const v = await setupV(1);
      await productionOracle.setBaselineMode(true);
      await productionOracle.setSingleVerifierOverride(v[0].address);
      const tx = await registry.connect(signers[10]).registerProducer(ethers.keccak256(ethers.toUtf8Bytes("B")), ethers.keccak256(ethers.toUtf8Bytes("m")), signers[10].address);
      const pid = registry.interface.parseLog((await tx.wait())?.logs.find(l => registry.interface.parseLog(l as any)?.name === "ProducerRegistered") as any)?.args.producerId;
      const hid = Math.floor(Date.now() / 1000 / 3600), ev = ethers.keccak256(ethers.toUtf8Bytes("e"));
      const t0 = (await ethers.provider.getBlock("latest"))?.timestamp || 0;
      await productionOracle.connect(v[0]).submitProduction(pid, hid, 5000n, ev, await sign(v[0], pid, hid, 5000n, ev, await productionOracle.getAddress()));
      const t1 = (await ethers.provider.getBlock("latest"))?.timestamp || 0;
      results.push({ name: "Baseline", gas: 0n, params: { latency: t1 - t0 } });
      console.log(`\n    Baseline: ${t1 - t0}s\n`);
      expect(await productionOracle.isFinalized(await productionOracle.getClaimKey(pid, hid))).to.be.true;
    });
  });
});
