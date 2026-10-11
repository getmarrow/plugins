// Compiles the codex/marrow hook matchers with Rust's `regex` crate (the engine Codex uses for hook
// matchers) and checks every name in the generated table. Built for wasm32-wasip1 so it needs no C
// linker; tools/codex-check.cjs writes the table and runs it under Node's WASI.
// Table lines (hex keeps every byte, newlines included):
//   M <event> <hex matcher>      a matcher to compile
//   I <hex matcher>              the installer's Codex matcher (expected to be rejected)
//   N <0|1 gated> <hex name>     a tool name and whether it must reach the hook
use regex::Regex;
use std::process::exit;

fn unhex(s: &str) -> String {
    let bytes: Vec<u8> = (0..s.len()).step_by(2).map(|i| u8::from_str_radix(&s[i..i + 2], 16).unwrap()).collect();
    String::from_utf8(bytes).unwrap()
}

fn main() {
    let path = std::env::args().nth(1).expect("table path");
    let text = std::fs::read_to_string(path).unwrap();
    let mut matchers = Vec::new();
    let mut names = Vec::new();
    let mut failures = 0;
    for line in text.lines() {
        let parts: Vec<&str> = line.split(' ').collect();
        match parts[0] {
            "M" => matchers.push((parts[1].to_string(), unhex(parts[2]))),
            "I" => match Regex::new(&unhex(parts[1])) {
                Ok(_) => { println!("FAIL installer matcher compiled; expected the lookaround error"); failures += 1; }
                Err(e) => println!("PASS installer Codex matcher is rejected by Rust regex ({})", e.to_string().lines().last().unwrap_or("").trim()),
            },
            "N" => names.push((parts[1] == "1", unhex(parts[2]))),
            _ => {}
        }
    }
    for (event, matcher) in &matchers {
        let re = match Regex::new(matcher) {
            Ok(re) => re,
            Err(e) => { println!("FAIL {event} matcher does not compile: {e}"); exit(1); }
        };
        let (mut gated, mut skipped) = (0, 0);
        for (want, name) in &names {
            let got = re.is_match(name);
            if got != *want { failures += 1; println!("FAIL {event} {name:?}: gated={got}, want {want}"); }
            if got { gated += 1 } else { skipped += 1 }
        }
        println!("PASS {event}: {} names, {gated} gated, {skipped} skipped", names.len());
    }
    if failures > 0 { println!("{failures} FAILED"); exit(1) }
    println!("ALL PASS (regex crate, {} matchers)", matchers.len());
}
