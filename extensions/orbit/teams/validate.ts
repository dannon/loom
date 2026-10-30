import type { TeamSpec } from "./types";

export class ValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ValidationError";
  }
}

export function validateTeamSpec(spec: TeamSpec): void {
  if (!spec.description || spec.description.trim().length === 0) {
    throw new ValidationError("TeamSpec.description must be a non-empty string");
  }

  const roles = spec.roles;
  if (!Array.isArray(roles) || roles.length < 2) {
    throw new ValidationError("TeamSpec.roles must contain at least 2 roles");
  }
  if (roles.length > 2) {
    throw new ValidationError(
      "TeamSpec.roles contains more than 2 roles; >2 roles is not implemented in this MVP",
    );
  }

  const seen = new Set<string>();
  for (const role of roles) {
    if (typeof role.name !== "string" || role.name.trim().length === 0) {
      throw new ValidationError("Every RoleSpec must have a non-empty name");
    }
    if (seen.has(role.name)) {
      throw new ValidationError(`RoleSpec.name must be unique; duplicate: "${role.name}"`);
    }
    seen.add(role.name);
  }

  const max = spec.max_rounds;
  if (max !== undefined) {
    if (!Number.isInteger(max) || max < 1 || max > 20) {
      throw new ValidationError("TeamSpec.max_rounds must be an integer in [1, 20]");
    }
  }
}
