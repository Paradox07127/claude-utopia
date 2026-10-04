// Synthetic xcodebuild output in the real format, as a Bash tool result.
export default `Exit code 65
􀟈 Test "A failed load keeps the previous document" started.
􀟈 Test case passing 1 argument cached → true to "A failed load keeps the previous document" started.
​􀟈 Test case passing 1 argument cached → false to "A failed load keeps the previous document" started.
​􁁛 Test "A failed load keeps the previous document" with 2 test cases passed after 0.100 seconds.
􀢄 Test "Parser keeps trailing whitespace" recorded an issue at ParserTests.swift:40:9: Expectation failed: tokens.last == .whitespace(2)
􀢄 Test "Parser keeps trailing whitespace" recorded an issue at ParserTests.swift:40:9: Expectation failed: tokens.last == .whitespace(2)
􀢄 Test "Parser keeps trailing whitespace" recorded an issue at ParserTests.swift:40:9: Expectation failed: tokens.last == .whitespace(2)
􀢄 Test "Parser keeps trailing whitespace" failed after 0.010 seconds with 3 issues.
􀢄 Test "Parser joins continuation lines" recorded an issue at ParserTests.swift:62:9: Expectation failed: lines.count == 1
􀢄 Test "Parser joins continuation lines" recorded an issue at ParserTests.swift:63:9: Expectation failed: lines[0] == "alpha beta"
􀢄 Test "Parser joins continuation lines" failed after 0.010 seconds with 2 issues.
􀢄 Suite "Parser" failed after 0.020 seconds with 5 issues.
􀢄 Test "Layout wraps long words at the column edge" recorded an issue at LayoutTests.swift:120:9: Expectation failed: frame.maxX <= 320
􀢄 Test "Layout wraps long words at the column edge" failed after 0.020 seconds with 1 issue.
􀢄 Test "Layout keeps the height of an empty line" recorded an issue at LayoutTests.swift:140:9: Expectation failed: rows[1].height == 18
􀢄 Test "Layout keeps the height of an empty line" recorded an issue at LayoutTests.swift:141:9: Expectation failed: rows.count == 3
􀢄 Test "Layout keeps the height of an empty line" failed after 0.010 seconds with 2 issues.
􀢄 Test "Theme colors resolve in dark mode" recorded an issue at ThemeTests.swift:30:9: Expectation failed: theme.background == .black
􀢄 Test "Theme colors resolve in dark mode" failed after 0.010 seconds with 1 issue.
􀢄 Test "Toolbar buttons stay disabled while a save runs" recorded an issue at ToolbarTests.swift:75:9: Expectation failed: toolbar.saveButton.isEnabled == false
􀢄 Test "Toolbar buttons stay disab

... [2400 characters truncated] ...

isEnabled == false
􀢄 Test "Both window sizes centre the empty-state stack" recorded an issue with 1 argument size → (1200.0, 800.0) at EmptyStateLayoutTests.swift:40:9: Expectation failed: abs(layout.icon.midX - size.width / 2) < 0.001
􀢄 Test "Both window sizes centre the empty-state stack" recorded an issue with 1 argument size → (1200.0, 800.0) at EmptyStateLayoutTests.swift:41:9: Expectation failed: layout.icon.height == 64
􀢄 Test "Both window sizes centre the empty-state stack" recorded an issue with 1 argument size → (1200.0, 800.0) at EmptyStateLayoutTests.swift:44:9: Expectation failed: layout.button.minY - layout.icon.maxY == 16
􀢄 Test "Both window sizes centre the empty-state stack" recorded an issue with 1 argument size → (1000.0, 700.0) at EmptyStateLayoutTests.swift:40:9: Expectation failed: abs(layout.icon.midX - size.width / 2) < 0.001
􀢄 Test "Both window sizes centre the empty-state stack" recorded an issue with 1 argument size → (1000.0, 700.0) at EmptyStateLayoutTests.swift:41:9: Expectation failed: layout.icon.height == 64
􀢄 Test "Both window sizes centre the empty-state stack" recorded an issue with 1 argument size → (1000.0, 700.0) at EmptyStateLayoutTests.swift:44:9: Expectation failed: layout.button.minY - layout.icon.maxY == 16
​􀢄 Test "Both window sizes centre the empty-state stack" with 2 test cases failed after 0.010 seconds with 6 issues.
􀢄 Test "A view too small for the stack shows nothing" recorded an issue at EmptyStateLayoutTests.swift:90:9: Expectation failed: layout(CGSize(width: 100, height: 100)) == nil
􀢄 Test "A view too small for the stack shows nothing" failed after 0.010 seconds with 1 issue.
􀢄 Suite "Empty state layout" failed after 0.020 seconds with 7 issues.
􀢄 Test "Status row centres its label on the card" recorded an issue with 1 argument size → (1200.0, 800.0) at StatusRowTests.swift:50:9: Expectation failed: row.label.width == 96
􀢄 Test "Status row centres its label on the card" recorded an issue with 1 argument size → (1200.0, 800.0) at StatusRowTests.swift:51:9: Expectation failed: abs(row.label.midX - width / 2) < 0.001
􀢄 Test "Status row centres its label on the card" recorded an issue with 1 argument size → (1000.0, 700.0) at StatusRowTests.swift:50:9: Expectation failed: row.label.width == 96
`
