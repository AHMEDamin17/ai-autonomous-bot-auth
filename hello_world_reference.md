# Hello World in Multiple Languages

## Python
```python
print("Hello, World!")
```

## JavaScript / Node.js
```javascript
console.log("Hello, World!");
```

## TypeScript
```typescript
console.log("Hello, World!");
```

## Ruby
```ruby
puts "Hello, World!"
```

## Go
```go
package main

import "fmt"

func main() {
    fmt.Println("Hello, World!")
}
```

## Rust
```rust
fn main() {
    println!("Hello, World!");
}
```

## Java
```java
public class HelloWorld {
    public static void main(String[] args) {
        System.out.println("Hello, World!");
    }
}
```

## C
```c
#include <stdio.h>

int main() {
    printf("Hello, World!\n");
    return 0;
}
```

## C++
```cpp
#include <iostream>

int main() {
    std::cout << "Hello, World!" << std::endl;
    return 0;
}
```

## C#
```csharp
using System;

class Program {
    static void Main() {
        Console.WriteLine("Hello, World!");
    }
}
```

## PHP
```php
<?php
echo "Hello, World!\n";
?>
```

## Swift
```swift
print("Hello, World!")
```

## Kotlin
```kotlin
fun main() {
    println("Hello, World!")
}
```

## Scala
```scala
object HelloWorld {
    def main(args: Array[String]): Unit = {
        println("Hello, World!")
    }
}
```

## R
```r
cat("Hello, World!\n")
```

## Julia
```julia
println("Hello, World!")
```

## Lua
```lua
print("Hello, World!")
```

## Perl
```perl
print "Hello, World!\n";
```

## Bash / Shell
```bash
#!/bin/bash
echo "Hello, World!"
```

## PowerShell
```powershell
Write-Host "Hello, World!"
```

## Haskell
```haskell
main :: IO ()
main = putStrLn "Hello, World!"
```

## Elixir
```elixir
IO.puts("Hello, World!")
```

## Erlang
```erlang
-module(hello).
-export([main/0]).

main() ->
    io:format("Hello, World!~n").
```

## Dart
```dart
void main() {
    print("Hello, World!");
}
```

## Zig
```zig
const std = @import("std");

pub fn main() !void {
    std.debug.print("Hello, World!\n", .{});
}
```

## Nim
```nim
echo "Hello, World!"
```

## Crystal
```crystal
puts "Hello, World!"
```

## F#
```fsharp
printfn "Hello, World!"
```

## OCaml
```ocaml
print_endline "Hello, World!"
```

## Assembly (x86-64 Linux NASM)
```assembly
section .data
    msg db "Hello, World!", 0xA
    len equ $ - msg

section .text
    global _start

_start:
    mov rax, 1          ; sys_write
    mov rdi, 1          ; stdout
    mov rsi, msg        ; message
    mov rdx, len        ; length
    syscall

    mov rax, 60         ; sys_exit
    xor rdi, rdi        ; exit code 0
    syscall
```

## SQL
```sql
SELECT 'Hello, World!' AS message;
```

## HTML
```html
<!DOCTYPE html>
<html>
<head>
    <title>Hello World</title>
</head>
<body>
    <h1>Hello, World!</h1>
</body>
</html>
```

## CSS
```css
/* CSS doesn't output text directly, but: */
body::before {
    content: "Hello, World!";
    display: block;
}
```

## JSON
```json
{
    "message": "Hello, World!"
}
```

## YAML
```yaml
message: "Hello, World!"
```

## TOML
```toml
message = "Hello, World!"
```

## XML
```xml
<?xml version="1.0" encoding="UTF-8"?>
<message>Hello, World!</message>
```

## Markdown
```markdown
# Hello, World!
```

## Regular Expression
```regex
/Hello, World!/
```

---

## How to Run Each

| Language | Command |
|----------|---------|
| Python | `python3 hello.py` |
| Node.js | `node hello.js` |
| Ruby | `ruby hello.rb` |
| Go | `go run hello.go` |
| Rust | `rustc hello.rs && ./hello` |
| Java | `javac HelloWorld.java && java HelloWorld` |
| C | `gcc hello.c -o hello && ./hello` |
| C++ | `g++ hello.cpp -o hello && ./hello` |
| C# | `dotnet run` (in project) |
| PHP | `php hello.php` |
| Swift | `swift hello.swift` |
| Kotlin | `kotlinc hello.kt -include-runtime -d hello.jar && java -jar hello.jar` |
| R | `Rscript hello.R` |
| Julia | `julia hello.jl` |
| Lua | `lua hello.lua` |
| Perl | `perl hello.pl` |
| Bash | `bash hello.sh` |
| PowerShell | `pwsh hello.ps1` |
| Haskell | `runhaskell hello.hs` |
| Elixir | `elixir hello.exs` |
| Erlang | `erl -noshell -s hello main -s init stop` |
| Dart | `dart hello.dart` |
| Zig | `zig run hello.zig` |
| Nim | `nim c -r hello.nim` |
| Crystal | `crystal hello.cr` |
| F# | `dotnet fsi hello.fsx` |
| OCaml | `ocaml hello.ml` |
| Assembly | `nasm -f elf64 hello.asm && ld hello.o -o hello && ./hello` |