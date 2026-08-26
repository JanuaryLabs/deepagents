# Map first-party plugins to definitions, bindings, and handles

Type: grilling
Status: open
Blocked by: 05

## Question

For `fileAgents`, `conversationScheduling`, `schedules`, and `@deepagents/devtool`, which inputs are reusable definition configuration, which are runtime bindings, which resources are borrowed or instance-owned, which lifecycle hooks remain, and which runtime-owned handles are public? The answer must expose any capability missing from the common contract rather than creating plugin-specific side doors.
