import asyncio

from controls import Controls, next_index


def test_next_and_prev_move_one_step():
    assert next_index(3, "next", 10) == 4
    assert next_index(3, "prev", 10) == 2


def test_prev_stops_at_first_step():
    assert next_index(0, "prev", 10) == 0


def test_reexplain_stays_on_step():
    assert next_index(3, "reexplain", 10) == 3


def test_toggle_pauses_and_resumes():
    c = Controls()
    c.command("toggle")
    assert c.paused
    c.command("toggle")
    assert not c.paused


def test_jump_resumes_and_is_taken_once():
    async def go():
        c = Controls()
        c.pause()
        c.command("next")
        assert not c.paused
        await asyncio.wait_for(c.wait_jump(), 0.1)
        assert c.take_jump() == "next"
        assert c.take_jump() is None

    asyncio.run(go())


def test_wait_unpaused_blocks_until_resume():
    async def go():
        c = Controls()
        c.pause()
        waiter = asyncio.create_task(c.wait_unpaused())
        await asyncio.sleep(0.01)
        assert not waiter.done()
        c.resume()
        await asyncio.wait_for(waiter, 0.1)

    asyncio.run(go())


def test_unknown_command_ignored():
    c = Controls()
    c.command("dance")
    assert not c.paused and c.take_jump() is None
