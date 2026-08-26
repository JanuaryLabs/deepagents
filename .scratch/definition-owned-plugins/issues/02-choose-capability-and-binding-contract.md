# Choose capability identity and binding resolution

Type: grilling
Status: open
Blocked by: 01

## Question

How are runtime capabilities identified, typed, required by plugin definitions, and supplied exactly once by the runtime host? Decide whether capabilities use typed tokens or another minimal identity, whether one binding may satisfy several plugins requiring the same semantic capability, how host values remain type-safe without whole-agent generic proof, and the deterministic errors for missing, duplicate, conflicting, unknown, and unused bindings.
