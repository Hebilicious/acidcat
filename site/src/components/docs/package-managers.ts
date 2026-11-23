export interface PackageManager {
  readonly name: string;
  readonly add: string;
  readonly devFlag: string;
  readonly exec: string;
}

export const packageManagers: readonly PackageManager[] = [
  { name: "pnpm", add: "pnpm add", devFlag: "-D", exec: "pnpm exec" },
  { name: "npm", add: "npm install", devFlag: "-D", exec: "npx" },
  { name: "yarn", add: "yarn add", devFlag: "-D", exec: "yarn" },
  { name: "bun", add: "bun add", devFlag: "-d", exec: "bunx" },
];
