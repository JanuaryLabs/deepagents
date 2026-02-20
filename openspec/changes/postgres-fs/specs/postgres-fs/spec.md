## ADDED Requirements

### Requirement: PostgresFs implements IFileSystem

`PostgresFs` SHALL implement the full `IFileSystem` interface from `just-bash`, providing all file, directory, and symlink operations backed by PostgreSQL storage.

#### Scenario: Class exports and implements interface

- **WHEN** a consumer imports `PostgresFs` from `@deepagents/text2sql`
- **THEN** the class SHALL implement `IFileSystem` with all required methods: `readFile`, `writeFile`, `appendFile`, `exists`, `stat`, `lstat`, `mkdir`, `readdir`, `readdirWithFileTypes`, `rm`, `cp`, `mv`, `chmod`, `symlink`, `link`, `readlink`, `realpath`, `utimes`, `resolvePath`, `getAllPaths`

### Requirement: Pool injection with ownership semantics

`PostgresFs` SHALL accept a `pg.Pool` instance, a `PoolConfig` object, or a connection string. When given a config/string, it SHALL create and own the pool. When given an existing `Pool`, it SHALL NOT close it on `close()`.

#### Scenario: Connection string creates owned pool

- **WHEN** `PostgresFs` is constructed with a connection string
- **THEN** it SHALL create a new `pg.Pool` internally and close it when `close()` is called

#### Scenario: Existing pool is not closed

- **WHEN** `PostgresFs` is constructed with an existing `pg.Pool` instance
- **THEN** calling `close()` SHALL NOT close the external pool
- **THEN** the external pool SHALL remain usable after `PostgresFs.close()`

### Requirement: Explicit initialization

`PostgresFs` SHALL require an explicit `await fs.initialize()` call after construction before any operations can be performed.

#### Scenario: Operations before initialize throw

- **WHEN** any filesystem method is called before `initialize()`
- **THEN** it SHALL throw an error indicating initialization is required

#### Scenario: Initialize creates schema and tables

- **WHEN** `initialize()` is called
- **THEN** it SHALL create the PostgreSQL schema (if not exists), `fs_entries` table, `fs_chunks` table, and root directory entry

#### Scenario: Idempotent initialization

- **WHEN** `initialize()` is called multiple times
- **THEN** it SHALL succeed without error and not duplicate data

### Requirement: Schema scoping

`PostgresFs` SHALL support PostgreSQL schema scoping to isolate tables under a named schema. The default schema SHALL be `public`.

#### Scenario: Custom schema creates tables in that schema

- **WHEN** `PostgresFs` is constructed with `schema: 'custom_schema'`
- **THEN** all tables SHALL be created under the `custom_schema` PostgreSQL schema

#### Scenario: Invalid schema name rejected

- **WHEN** a schema name not matching `/^[a-zA-Z_]\w*$/` is provided
- **THEN** the constructor SHALL throw an error

### Requirement: Root path isolation

`PostgresFs` SHALL support a `root` option that prefixes all internal paths, providing namespace isolation. External callers SHALL see unprefixed paths.

#### Scenario: Root path prefixing

- **WHEN** `PostgresFs` is constructed with `root: '/chat-123'`
- **THEN** `writeFile('/file.txt', 'data')` SHALL store the file at internal path `/chat-123/file.txt`
- **THEN** `readFile('/file.txt')` SHALL return the content stored at `/chat-123/file.txt`

#### Scenario: Root directory auto-creation

- **WHEN** `initialize()` is called with `root: '/a/b/c'`
- **THEN** directories `/a`, `/a/b`, and `/a/b/c` SHALL be created if they don't exist

#### Scenario: Two instances with different roots are isolated

- **WHEN** two `PostgresFs` instances share the same pool but have different roots
- **THEN** writing `/data.json` on each SHALL produce independent files

### Requirement: File read and write operations

`PostgresFs` SHALL support reading, writing, and appending files with both string and binary content.

#### Scenario: Write and read string content

- **WHEN** `writeFile('/test.txt', 'Hello')` is called
- **THEN** `readFile('/test.txt')` SHALL return `'Hello'`

#### Scenario: Write and read binary content

- **WHEN** `writeFile('/bin.dat', new Uint8Array([0x00, 0xFF]))` is called
- **THEN** `readFileBuffer('/bin.dat')` SHALL return the same `Uint8Array`

#### Scenario: Overwrite existing file

- **WHEN** `writeFile('/f.txt', 'v1')` then `writeFile('/f.txt', 'v2')` is called
- **THEN** `readFile('/f.txt')` SHALL return `'v2'`

#### Scenario: Append to file

- **WHEN** `writeFile('/f.txt', 'Hello')` then `appendFile('/f.txt', ', World!')` is called
- **THEN** `readFile('/f.txt')` SHALL return `'Hello, World!'`

#### Scenario: Read non-existent file throws ENOENT

- **WHEN** `readFile('/missing.txt')` is called
- **THEN** it SHALL throw an error matching `/ENOENT/`

#### Scenario: Auto-create parent directories on write

- **WHEN** `writeFile('/a/b/c/file.txt', 'data')` is called
- **THEN** directories `/a`, `/a/b`, `/a/b/c` SHALL be created automatically

### Requirement: Chunked file storage

`PostgresFs` SHALL store file content in chunks (default 1MB) in the `fs_chunks` table, supporting configurable chunk size.

#### Scenario: Large file stored in chunks

- **WHEN** a file larger than the chunk size is written
- **THEN** it SHALL be split into multiple chunks in `fs_chunks`
- **THEN** reading the file SHALL reassemble the chunks in order and return the original content

### Requirement: Directory operations

`PostgresFs` SHALL support creating directories, listing contents, and listing with file types.

#### Scenario: Create directory

- **WHEN** `mkdir('/dir')` is called
- **THEN** `stat('/dir')` SHALL return `isDirectory: true`

#### Scenario: Create directory recursively

- **WHEN** `mkdir('/a/b/c', { recursive: true })` is called
- **THEN** all intermediate directories SHALL be created

#### Scenario: List directory contents

- **WHEN** a directory contains files and subdirectories
- **THEN** `readdir()` SHALL return an array of direct child names (not full paths)

#### Scenario: List directory with file types

- **WHEN** `readdirWithFileTypes()` is called
- **THEN** each entry SHALL have `name`, `isFile`, `isDirectory`, `isSymbolicLink` properties

### Requirement: Remove operations

`PostgresFs` SHALL support removing files and directories.

#### Scenario: Remove file

- **WHEN** `rm('/file.txt')` is called on an existing file
- **THEN** `exists('/file.txt')` SHALL return `false`

#### Scenario: Remove directory recursively

- **WHEN** `rm('/dir', { recursive: true })` is called on a non-empty directory
- **THEN** the directory and all contents SHALL be removed

#### Scenario: Force remove non-existent path

- **WHEN** `rm('/missing', { force: true })` is called
- **THEN** it SHALL NOT throw an error

### Requirement: Copy and move operations

`PostgresFs` SHALL support copying and moving files and directories.

#### Scenario: Copy file

- **WHEN** `cp('/src.txt', '/dst.txt')` is called
- **THEN** both files SHALL exist with identical content

#### Scenario: Copy directory recursively

- **WHEN** `cp('/srcdir', '/dstdir', { recursive: true })` is called
- **THEN** the entire directory tree SHALL be duplicated

#### Scenario: Move file

- **WHEN** `mv('/old.txt', '/new.txt')` is called
- **THEN** `/old.txt` SHALL no longer exist and `/new.txt` SHALL contain the original content

### Requirement: Symlink operations

`PostgresFs` SHALL support creating, reading, and resolving symbolic links.

#### Scenario: Create and read symlink

- **WHEN** `symlink('/target.txt', '/link.txt')` is called
- **THEN** `readlink('/link.txt')` SHALL return `'/target.txt'`
- **THEN** `readFile('/link.txt')` SHALL return the content of `/target.txt`

#### Scenario: stat follows symlinks, lstat does not

- **WHEN** `stat()` is called on a symlink
- **THEN** `isSymbolicLink` SHALL be `false` (follows to target)
- **WHEN** `lstat()` is called on the same symlink
- **THEN** `isSymbolicLink` SHALL be `true`

#### Scenario: Circular symlink detection

- **WHEN** a symlink chain forms a cycle
- **THEN** operations SHALL throw an error indicating circular symlink

### Requirement: Stat and metadata operations

`PostgresFs` SHALL support `stat`, `lstat`, `chmod`, and `utimes`.

#### Scenario: File stat returns correct metadata

- **WHEN** `stat()` is called on a file
- **THEN** it SHALL return `isFile: true`, correct `size`, and `mtime` as a `Date`

#### Scenario: chmod updates file mode

- **WHEN** `chmod('/file.txt', 0o755)` is called
- **THEN** `stat('/file.txt').mode` SHALL return `0o755`

### Requirement: getAllPaths synchronous throws

`PostgresFs` SHALL throw when `getAllPaths()` is called synchronously, and provide `getAllPathsAsync()` as the async alternative.

#### Scenario: Synchronous getAllPaths throws

- **WHEN** `getAllPaths()` is called
- **THEN** it SHALL throw an error directing callers to use `getAllPathsAsync()`

#### Scenario: Async getAllPathsAsync returns all paths

- **WHEN** `getAllPathsAsync()` is called
- **THEN** it SHALL return all stored paths sorted alphabetically

### Requirement: Lazy pg dependency

`PostgresFs` SHALL lazy-require the `pg` package via `createRequire`. If `pg` is not installed, construction SHALL throw a descriptive error.

#### Scenario: Missing pg package

- **WHEN** `PostgresFs` is constructed and `pg` is not installed
- **THEN** it SHALL throw an error with installation instructions

### Requirement: Transactional writes

All write operations (`writeFile`, `appendFile`, `mkdir`, `rm`, `cp`, `mv`, `symlink`, `link`) SHALL execute within a PostgreSQL transaction to ensure atomicity.

#### Scenario: Failed write rolls back

- **WHEN** an error occurs during a write operation
- **THEN** no partial changes SHALL be persisted to the database
