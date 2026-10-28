export interface GalaxyToolFamily {
  tool(tool: string): string;
  toolName(toolName: string | undefined): string | undefined;
}
export function bareFamily(tools: Iterable<string>): Readonly<GalaxyToolFamily>;
