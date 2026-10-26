// The first line of a role's system prompt: who it is and what TaskPilot is.
// Shared so every role describes the team the same way, including packages
// Coding Agent writes instead of the developer.
export const rolePreamble = (role: string) =>
  `You are ${role} on an AI team inside TaskPilot, a desktop app where AI agents plan software work and each work package is written either by the developer or by Coding Agent.`;
