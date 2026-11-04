# Column contracts

Add an idempotent column drop here only in a later release than the code that
stopped reading and writing it. The release guard checks the candidate and
both preceding serving images, including the supported rollback image.

The server leg applies these files only after both Machines serve the new
image. Each statement must be a single `ALTER TABLE` column drop with `IF EXISTS`.
Other migrations remain on the existing predeployment path.

The retired owner and star milestone columns remain compatibility storage;
this release deliberately has no column contracts.
