// A package manager written in something that is not JavaScript.
//
// It exports one symbol with the shape every C `main` has — `bundle_main(argc,
// argv) -> exit code` — so the thing that starts it needs to know nothing about
// Rust, and Rust needs to know nothing about node. The archive carries this
// shared library the same way it carries JavaScript, and a four-line stub
// dlopen()s it and calls it.
//
//   cargo build --release      ->  target/release/libnative_cli.{so,dylib,dll}
//
// `argv[0]` is the name the program was invoked as, which is what makes one
// archive able to answer to several command names.

use std::ffi::{c_char, c_int, CStr};

/// Run, the way C runs: `argc` arguments at `argv`, an exit code back.
///
/// # Safety
///
/// `argv` must point at `argc` NUL-terminated strings, as a C `main` receives.
/// The caller owns that memory and it must outlive the call.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn bundle_main(argc: c_int, argv: *const *const c_char) -> c_int {
    let args = match unsafe { collect(argc, argv) } {
        Some(args) => args,
        None => {
            eprintln!("native-cli: argv was not the shape a C main expects");
            return 64; // EX_USAGE
        }
    };

    let (program, rest) = args.split_first().map_or(("native-cli", &[][..]), |(p, r)| (p.as_str(), r));

    println!("hello from rust {}", rustc_version());
    println!("program: {program}");
    println!("args:    {rest:?}");

    // A real tool would dispatch here; this one only proves the plumbing, so it
    // reports what it was given and uses the exit code to prove that travels
    // back too.
    match rest.first().map(String::as_str) {
        Some("fail") => 3,
        Some("echo") => {
            for arg in &rest[1..] {
                println!("{arg}");
            }
            0
        }
        _ => 0,
    }
}

/// The version this library was built with, so the JavaScript side can show
/// that the code really did come from Rust rather than from a helpful stub.
fn rustc_version() -> &'static str {
    option_env!("CARGO_PKG_RUST_VERSION").unwrap_or("(unknown)")
}

unsafe fn collect(argc: c_int, argv: *const *const c_char) -> Option<Vec<String>> {
    if argv.is_null() || argc < 0 {
        return None;
    }
    let mut args = Vec::with_capacity(argc as usize);
    for i in 0..argc as isize {
        let entry = unsafe { *argv.offset(i) };
        if entry.is_null() {
            return None;
        }
        args.push(unsafe { CStr::from_ptr(entry) }.to_string_lossy().into_owned());
    }
    Some(args)
}
