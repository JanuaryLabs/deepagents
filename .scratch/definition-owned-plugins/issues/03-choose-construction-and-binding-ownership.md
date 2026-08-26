# Choose construction, initialization, and binding ownership

Type: grilling
Status: open
Blocked by: 02

## Question

Which work must complete synchronously during `AgentRuntime` construction, which work belongs to `initialize()` or `work()`, and who owns and disposes every binding or resource? Preserve construction-time binding failure while defining the boundary between borrowed host capabilities, synchronous factories, plugin-created state, asynchronous initialization, workers, and disposables.
