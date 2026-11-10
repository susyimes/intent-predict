---
id: fixture/oversize
version: 0.1.0
description: Test fixture. 15 intents with 80-character CJK descriptions fit a compact prompt but overflow the 4,000-byte fork budget (3 bytes per character). Not an example to copy.
scenarios:
  - id: oversize.any
    description: Any completed turn.
    match: { signal: lastTurn.status, eq: completed }
    intents:
      - id: intent_01
        description: "第 01 个意图：请代理按照既定方案继续推进当前这一项工作，并在完成之后给出一份简短的总结说明，同时列出仍然存在的风险点与后续的改进建议，方便用户据此决定下一步"
        render: "选项 01"
        risk: none
      - id: intent_02
        description: "第 02 个意图：请代理按照既定方案继续推进当前这一项工作，并在完成之后给出一份简短的总结说明，同时列出仍然存在的风险点与后续的改进建议，方便用户据此决定下一步"
        render: "选项 02"
        risk: none
      - id: intent_03
        description: "第 03 个意图：请代理按照既定方案继续推进当前这一项工作，并在完成之后给出一份简短的总结说明，同时列出仍然存在的风险点与后续的改进建议，方便用户据此决定下一步"
        render: "选项 03"
        risk: none
      - id: intent_04
        description: "第 04 个意图：请代理按照既定方案继续推进当前这一项工作，并在完成之后给出一份简短的总结说明，同时列出仍然存在的风险点与后续的改进建议，方便用户据此决定下一步"
        render: "选项 04"
        risk: none
      - id: intent_05
        description: "第 05 个意图：请代理按照既定方案继续推进当前这一项工作，并在完成之后给出一份简短的总结说明，同时列出仍然存在的风险点与后续的改进建议，方便用户据此决定下一步"
        render: "选项 05"
        risk: none
      - id: intent_06
        description: "第 06 个意图：请代理按照既定方案继续推进当前这一项工作，并在完成之后给出一份简短的总结说明，同时列出仍然存在的风险点与后续的改进建议，方便用户据此决定下一步"
        render: "选项 06"
        risk: none
      - id: intent_07
        description: "第 07 个意图：请代理按照既定方案继续推进当前这一项工作，并在完成之后给出一份简短的总结说明，同时列出仍然存在的风险点与后续的改进建议，方便用户据此决定下一步"
        render: "选项 07"
        risk: none
      - id: intent_08
        description: "第 08 个意图：请代理按照既定方案继续推进当前这一项工作，并在完成之后给出一份简短的总结说明，同时列出仍然存在的风险点与后续的改进建议，方便用户据此决定下一步"
        render: "选项 08"
        risk: none
      - id: intent_09
        description: "第 09 个意图：请代理按照既定方案继续推进当前这一项工作，并在完成之后给出一份简短的总结说明，同时列出仍然存在的风险点与后续的改进建议，方便用户据此决定下一步"
        render: "选项 09"
        risk: none
      - id: intent_10
        description: "第 10 个意图：请代理按照既定方案继续推进当前这一项工作，并在完成之后给出一份简短的总结说明，同时列出仍然存在的风险点与后续的改进建议，方便用户据此决定下一步"
        render: "选项 10"
        risk: none
      - id: intent_11
        description: "第 11 个意图：请代理按照既定方案继续推进当前这一项工作，并在完成之后给出一份简短的总结说明，同时列出仍然存在的风险点与后续的改进建议，方便用户据此决定下一步"
        render: "选项 11"
        risk: none
      - id: intent_12
        description: "第 12 个意图：请代理按照既定方案继续推进当前这一项工作，并在完成之后给出一份简短的总结说明，同时列出仍然存在的风险点与后续的改进建议，方便用户据此决定下一步"
        render: "选项 12"
        risk: none
      - id: intent_13
        description: "第 13 个意图：请代理按照既定方案继续推进当前这一项工作，并在完成之后给出一份简短的总结说明，同时列出仍然存在的风险点与后续的改进建议，方便用户据此决定下一步"
        render: "选项 13"
        risk: none
      - id: intent_14
        description: "第 14 个意图：请代理按照既定方案继续推进当前这一项工作，并在完成之后给出一份简短的总结说明，同时列出仍然存在的风险点与后续的改进建议，方便用户据此决定下一步"
        render: "选项 14"
        risk: none
      - id: intent_15
        description: "第 15 个意图：请代理按照既定方案继续推进当前这一项工作，并在完成之后给出一份简短的总结说明，同时列出仍然存在的风险点与后续的改进建议，方便用户据此决定下一步"
        render: "选项 15"
        risk: none
---
