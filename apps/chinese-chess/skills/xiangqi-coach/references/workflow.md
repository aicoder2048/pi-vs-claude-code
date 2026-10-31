# 四步证据与跳过
observe：已读 signals 可作为观察证据；analyze_position 提供完整报告，不必为重复相同资料浪费工具。
compare：先核对同一revision已有候选和自动搜索；证据足够可复用，缺多个候选时一次compare_moves，单个新候选可review_move，覆盖或深度不足再search_position。simulate_moves只证明填入路线合法，不证明对手必须配合。回合前自动搜索是宿主证据，不谎报为模型调用；审计中的skipped只表示未取得相应工具证据，不据此推断模型没有比较。
plan：update_plan 暂存公开计划，成功提交才持久化。跳过必须在审计标为 skipped，不凭 reason 猜测已做过。
commit：只有权威 commit 成功才 done；工具意图或失败请求不能算完成。风险反驳后优先改选，不能用“争取主动”套话绕过。
时间紧时减少读取和候选数量，不跳过合法性、应将或业务独立复查。预算耗尽且未落子时回合失败、棋钟继续。
