"""minimal fixture for py-direct verification."""
from __future__ import annotations


def greet(name: str) -> str:
    return f"hello, {name}"


def add(a: int, b: int) -> int:
    return a + b


class Counter:
    def __init__(self, start: int = 0) -> None:
        self.value = start

    def increment(self, by: int = 1) -> int:
        self.value += by
        return self.value


if __name__ == "__main__":
    print(greet("world"))
    print(add(1, 2))
    c = Counter()
    print(c.increment(5))
