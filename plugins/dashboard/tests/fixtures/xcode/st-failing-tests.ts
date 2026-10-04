// Synthetic xcodebuild output in the real format, as a Bash tool result.
export default `􀟈 Test "Parser keeps trailing whitespace" started.
􁁛 Test "Parser keeps trailing whitespace" passed after 0.001 seconds.
􀟈 Test "Parser drops a lone carriage return" started.
􁁛 Test "Parser drops a lone carriage return" passed after 0.001 seconds.
􀟈 Test "Parser joins continuation lines" started.
􁁛 Test "Parser joins continuation lines" passed after 0.001 seconds.
􀟈 Test "Parser reads an empty file as one empty line" started.
􁁛 Test "Parser reads an empty file as one empty line" passed after 0.001 seconds.
􀟈 Test "Tokenizer splits on Unicode word boundaries" started.
􁁛 Test "Tokenizer splits on Unicode word boundaries" passed after 0.002 seconds.
􀟈 Test "Tokenizer keeps escaped quotes inside a string" started.
􁁛 Test "Tokenizer keeps escaped quotes inside a string" passed after 0.001 seconds.
􀟈 Test "Tokenizer reports the column of an unterminated string" started.
􁁛 Test "Tokenizer reports the column of an unterminated string" passed after 0.001 seconds.
􀟈 Test "Layout wraps long words at the column edge" started.
􁁛 Test "Layout wraps long words at the column edge" passed after 0.010 seconds.
􀟈 Test "Layout keeps the height of an empty line" started.
􁁛 Test "Layout keeps the height of an empty line" passed after 0.005 seconds.
􀟈 Test "Layout clamps negative insets to zero" started.
􁁛 Test "Layout clamps negative insets to zero" passed after 0.002 seconds.
􀟈 Test "Glyph cache evicts the oldest entry first" started.
􁁛 Test "Glyph cache evicts the oldest entry first" passed after 0.003 seconds.
􀟈 Test "Glyph cache keys on font and size together" started.
􁁛 Test "Glyph cache keys on font and size together" passed after 0.001 seconds.
􀢄 Suite LayoutEngineTests failed after 0.100 seconds with 1 issue.
􀢄 Test run with 240 tests in 6 suites failed after 0.500 seconds with 3 issues.
2026-01-01 00:00:30.000 xcodebuild[51234:900001] [MT] IDETestOperationsObserverDebug: 8.000 elapsed -- Testing started completed.
2026-01-01 00:00:30.000 xcodebuild[51234:900001] [MT] IDETestOperationsObserverDebug: 0.000 sec, +0.000 sec -- start
2026-01-01 00:00:30.000 xcodebuild[51234:900001] [MT] IDETestOperationsObserverDebug: 8.000 sec, +8.000 sec -- end

Test session results, code coverage, and logs:
	/work/Library/Developer/Xcode/DerivedData/DemoApp-0000000000000000/Logs/Test/Test-DemoApp-2026.01.01_00-00-00-+0000.xcresult

Failing tests:
	TokenizerTests.splitsOnUnicodeWordBoundaries()
	TokenizerTests.keepsEscapedQuotesInsideAString()
	LayoutEngineTests.clampsNegativeInsetsToZero()

** TEST FAILED **

Testing started
`
