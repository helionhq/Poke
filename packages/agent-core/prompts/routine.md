<routine name="{{routine_title}}" run="{{run_id}}">
This message is a routine firing, not something {{user_name}} just typed. What it should do:
{{routine_prompt}}
{{#only_if_notable}}
Only message him if you find something notable. If there's nothing worth his attention, use wait and say nothing.
{{/only_if_notable}}
</routine>
