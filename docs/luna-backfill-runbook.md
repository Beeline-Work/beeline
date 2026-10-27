# Approved Luna backfill

Owner approval was relayed by Ruby (message ae9a4279, “Yes to everything otherwise”).
The hello is approved exactly as `LUNA_BACKFILL_HELLO`; `{name}` becomes the owner's
`@handle`. jellybean-beeline-test's team and Methoxine's team are excluded.

After merge and release, build the server and run `npm run backfill:luna` using
an approved DATABASE_URL secret environment. Inspect the read-only inventory,
then run `npm run backfill:luna -- --apply`. Do not run apply before release.
The CLI reads `scripts/luna-backfill-approved.json` and restricts this one-time
run to exactly these workspace/Room pairs. Missing or ineligible approved pairs
abort before writes; newly created workspaces never expand this approved run.
Existing Luna rows remain idempotent. Owner limits still apply and are printed.
No production apply was performed while preparing this PR.

The explicit Room is #general in Tubing Crew. The workspace exclusion has an
exception for this Room only. The remaining entries are the approved sweep.

| Workspace | Workspace ID | Room ID |
| --- | --- | --- |
| Petr B's team | `143da7ed-35d4-45b9-bf4f-4089c7d68a32` | `3221da6d-56ea-41e9-8d1c-106123865fcc` |
| Tubing Crew | `18e555f7-e191-452b-9b0f-b825f58ee4ba` | `289fbeab-3df5-4db3-9b70-d2fd3b937cae` |
| 1111 | `1df5c3a3-9eb8-45ed-9cd3-c66bf1d01fc6` | `2d85784e-fff2-45c8-9e8f-7c29f47083ee` |
| SUB0ZERO | `3678f265-3376-4578-9d8b-02abf7f14a6d` | `fcfdf9df-b9a0-4b38-b100-bc8e62fecf8d` |
| John | `3862c04f-77b8-48a9-b605-09e4e456ed71` | `f8529f56-4cfa-420e-bec7-2b83d33d86de` |
| Fibycraft | `4953442f-3df7-401a-a4da-d708aa21f6c9` | `8fd4564f-0084-4c6a-b707-0b540f175bfd` |
| Funn | `4d684f59-58da-4c6d-a13a-9fa8a8f3d162` | `0a4fd6cb-a62c-4fdd-8c7d-a42c94ac0625` |
| Myagent | `4e30498e-317c-4548-96df-7ba2bebc3ceb` | `251a0ffe-5406-4f1b-ac8a-0b613b06e47f` |
| Амир | `595c5368-13d0-47a9-8d08-eb06bb758fd9` | `82d75a99-66a5-4c01-b5e8-9e8aebb8defe` |
| Owl and Kestrel | `803f2c53-7737-4521-ab99-4dea4c3e8a83` | `cd9fb61b-e7c1-44e0-887a-b256ef281509` |
| HashFunnels Workspace | `81e1d2ed-9dea-421b-851b-ae5050cadd4d` | `5fb28d50-8894-4924-ae27-e986a585d801` |
| Mohammed Al-Maktary's team | `92fc85be-7708-4123-b133-465cf12ac1e5` | `812cb38b-5738-48c1-a1f4-26c8bbb3cab9` |
| Yozalem | `94d8592f-7e74-4db6-958b-c3622a7bf5f0` | `cb59b5aa-7cae-4240-87e3-cee11fe47725` |
| Klor | `9576c8c5-c8a5-4e7e-bf27-b658e979c2e3` | `657de573-275a-49f8-846d-668c98de86c8` |
| Dinesh Biyani's team | `9c870b6f-db44-4d74-8504-aa2d1d768103` | `8ad5b2ed-362c-4774-8b29-569ed2c5b2cc` |
| Aspars Jha's team | `ad8e64fd-e71d-4e19-8668-e76ea32a253c` | `23905fc3-ccd7-4289-a2c5-ecb62d0488b8` |
| Project Helios | `afa7014e-f3d5-4a51-b520-d334462a7838` | `db1cacdd-844c-49bc-a9e6-c430a853b094` |
| Fibycraft | `b0586c23-e830-41a8-a228-baf2ee257b9b` | `ef0a4d40-e320-4450-a7fc-fa9a979a4324` |
| exnex apps | `c8684f70-caea-427e-b625-6e0f9874b5e7` | `8a5a6302-bb94-4125-accc-a3e20bdd12df` |
| Review Sat's team | `d76ea62a-9732-4ed7-8e1f-6cfb692ae668` | `f66cb525-b0e5-4e38-90fd-b281402ed813` |
| Alan's team | `ea7a5979-c917-4db8-a6f9-6a3b8ebbe5cb` | `1b542430-ad81-41d8-a616-41218569bcea` |
| Nishant Srivastava's team | `f437c978-efbd-4327-abce-5fb0db30bf9c` | `d9c5e83f-18c5-40dd-9adf-05b833d28b56` |
| April Doran's team | `f6042e43-12b3-4888-8af0-ba3100c3be85` | `2c351281-c303-4094-a1b5-bac056483f25` |
| G | `fe0414a3-a141-45a1-9107-a46fd6c99275` | `5a173d00-ab66-486d-95ff-06ec0792f466` |
| Raj 07's team | `ff4ec279-f5cf-44b5-8be9-7c2be9978cce` | `c703726e-6898-4bae-b5a0-727147783f50` |
