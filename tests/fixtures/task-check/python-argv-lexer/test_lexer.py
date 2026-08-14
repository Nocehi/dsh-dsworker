import unittest

from lexer import parse_argv


class LexerTests(unittest.TestCase):
    def test_boundaries(self):
        self.assertEqual(parse_argv('a b'), ['a', 'b'])
        self.assertEqual(parse_argv('\"a b\" c'), ['a b', 'c'])
        self.assertEqual(parse_argv('a \"\" b'), ['a', '', 'b'])
        self.assertEqual(parse_argv('a\\ b'), ['a b'])

    def test_malformed_input(self):
        with self.assertRaises(ValueError):
            parse_argv('\"unterminated')
        with self.assertRaises(ValueError):
            parse_argv('trailing\\')


if __name__ == '__main__':
    unittest.main()
