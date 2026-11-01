#[test]
fn matches_python_clipclean() {
    let cases: Vec<serde_json::Value> = serde_json::from_str(include_str!("golden.json")).unwrap();
    let mut failed = 0;
    for (n, case) in cases.iter().enumerate() {
        let text = case["text"].as_str().unwrap();
        let width = case["width"].as_u64().unwrap() as usize;
        let got = (clipclean::detect(text), clipclean::clean(text, width), clipclean::cleaned(text));
        let want = ((case["tui"].as_bool().unwrap(), width), case["clean"].as_str().unwrap().to_string(), case["cleaned"].as_str().map(str::to_string));
        if got != want {
            failed += 1;
            if failed <= 3 {
                eprintln!("case {n}: {text:?}\n got {got:?}\nwant {want:?}");
            }
        }
    }
    assert_eq!(failed, 0, "{failed} of {} cases differ", cases.len());
}
