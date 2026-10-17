# Keiko Dojo

Keiko Dojo is the planned backend and business-logic service for MatMetrics and
other Judo training applications. It is planned to use Cloudflare D1 as its
primary data store, with user-configured GitHub repositories as optional backup
targets. MatMetrics remains the user-facing web app; Keiko Dojo will expose
shared capabilities through a versioned API and, later, an MCP interface.

This repository is currently a scaffold. See the
[implementation plan](IMPLEMENTATION_PLAN.md) for the proposed architecture,
migration sequence, and first delivery milestones.
