import { select, checkbox, confirm } from "@inquirer/prompts";
import chalk from "chalk";
import fs from "node:fs";
import path from "node:path";
import { detectServices } from "../services/detect";
import { scanCodebase } from "../services/scan";
import { writeConfig } from "../config/store";
import { SERVICE_CATALOG } from "../services/catalog";
import { promptApiKey } from "./api-key";

export async function runInit(): Promise<void> {
  try {
    await _runInit();
  } catch (err: any) {
    if (err.name === "ExitPromptError" || err.message?.includes("SIGINT")) {
      console.log("\n\n  Cancelled. Run `npx burn0 init` when ready.\n");
      process.exit(0);
    }
    throw err;
  }
}

async function _runInit(): Promise<void> {
  const cwd = process.cwd();

  console.log(chalk.dim("\n  burn0 — track every API cost\n"));

  // Step 1: API key
  const apiKey = await promptApiKey(cwd);

  // Step 2: Auto-detect + confirm services
  console.log(chalk.dim("\n  Scanning your project...\n"));

  const pkgServices = detectServices(cwd);
  const scannedServices = scanCodebase(cwd);
  const detectedNames = new Set(pkgServices.map((s) => s.name));
  const newFromScan = scannedServices.filter((s) => !detectedNames.has(s.name));

  // Build unified list of detected services
  interface DetectedSvc {
    name: string;
    displayName: string;
    autopriced: boolean;
  }
  const allDetected: DetectedSvc[] = [];

  for (const svc of pkgServices) {
    const entry = SERVICE_CATALOG.find((c) => c.name === svc.name);
    allDetected.push({
      name: svc.name,
      displayName: entry?.displayName ?? svc.name,
      autopriced: svc.autopriced,
    });
  }
  for (const svc of newFromScan) {
    const entry = SERVICE_CATALOG.find((c) => c.name === svc.name);
    allDetected.push({
      name: svc.name,
      displayName: entry?.displayName ?? svc.name,
      autopriced: entry?.pricingType !== "fixed",
    });
  }

  const serviceConfigs: {
    name: string;
    plan?: string;
    monthlyCost?: number;
  }[] = [];

  if (allDetected.length > 0) {
    // Show detected services (non-interactive display)
    console.log(
      chalk.bold(`  Auto-detected ${allDetected.length} services:\n`),
    );
    for (const svc of allDetected) {
      const tag = svc.autopriced
        ? chalk.dim("auto-priced")
        : chalk.yellow("needs plan");
      console.log(
        `  ${chalk.green("  ✓")}  ${svc.displayName.padEnd(20)} ${tag}`,
      );
    }
    console.log();

    // Prompt for fixed-tier service plans
    const fixedTier = allDetected.filter((s) => !s.autopriced);
    if (fixedTier.length > 0) {
      for (const svc of fixedTier) {
        const entry = SERVICE_CATALOG.find((c) => c.name === svc.name);
        if (entry?.plans) {
          const plan = await select({
            message: `${entry.displayName} — which plan?`,
            choices: [
              ...entry.plans.map((p) => ({ name: p.name, value: p.value })),
              { name: "Skip", value: "skip" },
            ],
          });
          if (plan !== "skip") {
            const selected = entry.plans.find((p) => p.value === plan);
            serviceConfigs.push({
              name: svc.name,
              plan,
              monthlyCost: selected?.monthly,
            });
          } else {
            serviceConfigs.push({ name: svc.name });
          }
        }
      }
    }

    // Add all auto-priced detected services to config
    for (const svc of allDetected.filter((s) => s.autopriced)) {
      serviceConfigs.push({ name: svc.name });
    }
  } else {
    console.log(chalk.dim("  No services detected.\n"));
  }

  // Ask if they want to add more services
  const addMore = await confirm({
    message: "Add other services you use?",
    default: false,
  });

  if (addMore) {
    const alreadyAdded = new Set(serviceConfigs.map((s) => s.name));
    const additionalServices = SERVICE_CATALOG.filter(
      (s) => !alreadyAdded.has(s.name),
    );

    const llmChoices = additionalServices
      .filter((s) => s.category === "llm")
      .map((s) => ({ name: s.displayName, value: s.name }));
    const apiChoices = additionalServices
      .filter((s) => s.category === "api")
      .map((s) => ({ name: s.displayName, value: s.name }));
    const infraChoices = additionalServices
      .filter((s) => s.category === "infra")
      .map((s) => ({ name: s.displayName, value: s.name }));

    const additional = await checkbox({
      message: "Select services:",
      choices: [
        ...(llmChoices.length
          ? [
              {
                name: chalk.bold.blue("── LLM Providers ──"),
                value: "__sep",
                disabled: true as any,
              },
            ]
          : []),
        ...llmChoices,
        ...(apiChoices.length
          ? [
              {
                name: chalk.bold.magenta("── API Services ──"),
                value: "__sep2",
                disabled: true as any,
              },
            ]
          : []),
        ...apiChoices,
        ...(infraChoices.length
          ? [
              {
                name: chalk.bold.yellow("── Infrastructure ──"),
                value: "__sep3",
                disabled: true as any,
              },
            ]
          : []),
        ...infraChoices,
      ],
    });

    for (const name of additional) {
      if (name.startsWith("__sep")) continue;
      const entry = SERVICE_CATALOG.find((c) => c.name === name);
      if (entry?.pricingType === "fixed" && entry.plans) {
        const plan = await select({
          message: `${entry.displayName} — which plan?`,
          choices: [
            ...entry.plans.map((p) => ({ name: p.name, value: p.value })),
            { name: "Skip", value: "skip" },
          ],
        });
        if (plan !== "skip") {
          const selected = entry.plans.find((p) => p.value === plan);
          serviceConfigs.push({ name, plan, monthlyCost: selected?.monthly });
        } else {
          serviceConfigs.push({ name });
        }
      } else {
        serviceConfigs.push({ name });
      }
    }
  }

  // Read project name from package.json
  let projectName = "my-project";
  try {
    const pkg = JSON.parse(
      fs.readFileSync(path.join(cwd, "package.json"), "utf-8"),
    );
    if (pkg.name) projectName = pkg.name;
  } catch {}

  // Write config
  writeConfig(cwd, {
    projectName,
    services: serviceConfigs.map((s) => ({
      name: s.name,
      pricingModel: s.plan ? ("fixed-tier" as const) : ("auto" as const),
      plan: s.plan,
      monthlyCost: s.monthlyCost,
    })),
  });

  // Sync config to server if API key was provided
  if (apiKey) {
    try {
      const apiUrl = "https://burn0-server-production.up.railway.app";
      const res = await fetch(`${apiUrl}/v1/projects/config`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          services: serviceConfigs.map((s) => ({
            name: s.name,
            pricingModel: s.plan ? "fixed-tier" : "auto",
            plan: s.plan,
            monthlyCost: s.monthlyCost,
          })),
        }),
      });
      if (res.ok) {
        console.log(chalk.green("  ✓ Config synced to burn0.dev"));
      }
    } catch {}
  }

  // Ensure .burn0/ in gitignore
  ensureGitignore(cwd, ".burn0/");

  // Ensure .env is in gitignore (protect secrets)
  const gitignorePath = path.join(cwd, ".gitignore");
  let gitignoreContent = "";
  try {
    gitignoreContent = fs.readFileSync(gitignorePath, "utf-8");
  } catch {}
  const gitignoreLines = gitignoreContent.split("\n").map((l) => l.trim());
  if (!gitignoreLines.includes(".env")) {
    ensureGitignore(cwd, ".env");
    console.log(
      chalk.green("  ✓ Added .env to .gitignore (protects your API keys)"),
    );
  }

  // Step 3: Done
  console.log("");
  console.log(chalk.green("  ✓ Setup complete"));
  console.log("");
  console.log(chalk.dim("  Add this to your entry file:"));
  console.log(chalk.white("    import '@burn0/burn0'"));
  console.log("");
  console.log(chalk.dim("  Then run your app to see costs."));
  console.log("");
}

export function ensureGitignore(cwd: string, entry: string): void {
  const gitignorePath = path.join(cwd, ".gitignore");
  let content = "";
  try {
    content = fs.readFileSync(gitignorePath, "utf-8");
  } catch {}
  const lines = content.split("\n").map((l) => l.trim());
  if (!lines.includes(entry)) {
    content += `${content && !content.endsWith("\n") ? "\n" : ""}${entry}\n`;
    fs.writeFileSync(gitignorePath, content);
  }
}
