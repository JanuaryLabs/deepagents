# Prototype the authoring, binding, and runtime handle API

Type: prototype
Status: open
Blocked by: 03, 04

## Question

What is the smallest coherent TypeScript API through which an agent author declares plugins, a runtime host supplies bindings, and that host retrieves runtime-owned controls such as `ScheduleControl` and the devtool URL? Produce a rough public-boundary prototype covering inline and named plugin definitions, two runtimes from one exported agent, typed capability values, handle availability across construction/initialization/work, and actionable failure examples so the final shape can be chosen through concrete use.
