import pytest

from demo import add


def test_adds_two_numbers() -> None:
    assert add(2, 2) == 4


@pytest.mark.skip(reason="slow")
def test_skipped_case() -> None:
    assert add(0, 0) == 0
