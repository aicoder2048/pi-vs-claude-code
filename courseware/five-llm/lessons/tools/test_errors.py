"""出错时给学员看的是一句人话，原始错误只写进服务日志。

运行（在课程目录下）：uv run --no-project python -m unittest discover -s tools -p "test_*.py"
"""

import io
import socket
import unittest
import urllib.error

import serve


def http_error(code, body=b'{"error":{"message":"Internal Server Error (request_id: 33f7)"}}'):
    return urllib.error.HTTPError("u", code, "err", {}, io.BytesIO(body))


class FriendlyErrorTest(unittest.TestCase):
    def say(self, e):
        return serve.friendly_error(e)

    def test_server_error_hides_raw_json(self):
        msg = self.say(http_error(500))
        self.assertIn("DeepSeek 服务", msg)
        self.assertNotIn("request_id", msg)
        self.assertNotIn("{", msg)

    def test_gateway_timeout_counts_as_server_side(self):
        self.assertIn("DeepSeek 服务", self.say(http_error(504)))

    def test_bad_key(self):
        self.assertIn("API key", self.say(http_error(401)))

    def test_no_balance(self):
        self.assertIn("余额", self.say(http_error(402)))

    def test_rate_limited(self):
        self.assertIn("太频繁", self.say(http_error(429)))

    def test_network_down(self):
        self.assertIn("连不上 DeepSeek", self.say(urllib.error.URLError(socket.gaierror("nodename"))))

    def test_timeout(self):
        self.assertIn("没有响应", self.say(TimeoutError("timed out")))

    def test_anything_else_is_a_generic_sentence(self):
        msg = self.say(ValueError("Expecting value: line 1 column 1 (char 0)"))
        self.assertNotIn("Expecting", msg)
        self.assertIn("重新发送", msg)


if __name__ == "__main__":
    unittest.main()
