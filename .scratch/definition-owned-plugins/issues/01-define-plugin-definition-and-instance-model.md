# Define the plugin definition and runtime instance model

Type: grilling
Status: open
Blocked by: none

## Question

What is the smallest public object model that cleanly separates a reusable plugin definition stored by the root agent definition from the stateful plugin instance owned by one `AgentRuntime`? Decide their canonical names, identity, generic parameters, static contributions, materialization seam, and which parts of the current `AgentRuntimePlugin` contract remain on the instance.
