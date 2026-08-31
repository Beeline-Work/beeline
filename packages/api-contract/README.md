# @beeline/api-contract

Compile-time and validation contracts for the relay-to-monolith migration. The only public entry points are `@beeline/api-contract/phone` and `@beeline/api-contract/daemon`.

- `phone` owns the existing RoomView DTOs/guards plus named future phone operations.
- `daemon` owns named future daemon operations. It deliberately has no generic event query/publish surface.
- `docs/` contains the current call-site inventories and measured Phase A cost gate.

This package adds no server implementation and changes no production behavior.
